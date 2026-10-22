import { Injectable, Logger, Inject, forwardRef, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import Redis from 'ioredis';
import { QueueService } from '../queue-orchestration/queue.service';
import { TelephonyGateway } from './telephony.gateway';
import { LivekitService } from './livekit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { NormalizedCallEvent, OutboundCallRequest } from './providers/telephony-provider.interface';
import type { FileInfo } from '@livekit/protocol';

@Injectable()
export class TelephonyService {
  private readonly logger = new Logger(TelephonyService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    @Inject(forwardRef(() => QueueService)) private readonly queueService: QueueService,
    @Inject(forwardRef(() => TelephonyGateway)) private readonly telephonyGateway: TelephonyGateway,
    @Inject(forwardRef(() => LivekitService)) private readonly livekitService: LivekitService,
    private readonly analyticsService: AnalyticsService,
  ) { }

  // ==========================================
  // CRM CONTEXT & VOICEBOT
  // ==========================================
  async lookupCustomerContext(phoneNumber: string) {
    this.logger.log(`Looking up customer context for phone: ${phoneNumber}`);
    try {
      // Search in Customer table
      const customer = await this.prisma.customer.findUnique({
        where: { phone: phoneNumber },
        include: { servicePlans: true, tickets: true }, // Included tickets
      });

      // Search in Lead table
      const lead = await this.prisma.lead.findUnique({
        where: { phoneNumber },
        include: { assignedAgent: true },
      });

      return {
        customer: customer || lead || null,
        priority: customer ? (customer as any).priority || 'Normal' : 'Normal',
        servicePlans: customer?.servicePlans || [],
        tickets: customer?.tickets || [],
      };
    } catch (error) {
      this.logger.error(
        `Error looking up customer context: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  // ==========================================
  // CALL SESSION TRACKING (PHASE 8)
  // ==========================================
  async createCallSession(
    callSid: string,
    roomName: string,
    customerId?: string,
    agentId?: string,
    direction?: string,
    phone?: string,
    leadId?: string,
    conversationId?: string,
  ) {
    this.logger.log(`Creating CallSession for ${callSid} in room ${roomName} leadId=${leadId} convId=${conversationId}`);
    try {
      return await this.prisma.callSession.create({
        data: {
          reason: callSid, // Store Vobiz CallSid here since it's not a valid UUID
          customerId: customerId || undefined,
          leadId: leadId || undefined,
          conversationId: conversationId || undefined,
          calleeUserId: agentId, // mapped to agent user ID theoretically
          status: 'RINGING',
          startedAt: new Date(),
          livekitRoom: roomName,
          transferHistory: { direction: direction || 'unknown', phone: phone || null },
          participants: {
            create: [], // will add later on connect
          },
        },
      });
    } catch (e) {
      this.logger.error(`Failed to create CallSession: ${e.message}`);
    }
  }

  async acceptCallSession(callSid: string, userIdOrAgentId: string) {
    this.logger.log(`Agent ${userIdOrAgentId} accepted CallSession ${callSid}`);
    try {
      // Find session by callSid stored in reason
      const session = await this.prisma.callSession.findFirst({
        where: { reason: callSid },
      });
      if (!session) return;

      // Resolve actual Agent ID (since socket passes User ID)
      let agent = await this.prisma.agent.findFirst({
        where: { userId: userIdOrAgentId },
      });
      if (!agent) {
        agent = await this.prisma.agent.findUnique({
          where: { id: userIdOrAgentId },
        });
      }
      const realAgentId = agent ? agent.id : userIdOrAgentId;

      await this.prisma.callSession.update({
        where: { id: session.id },
        data: {
          status: 'IN_PROGRESS',
        },
      });
      await this.prisma.callParticipant.create({
        data: {
          callSessionId: session.id,
          agentId: realAgentId,
          role: 'AGENT',
          joinedAt: new Date(),
        },
      });
    } catch (e) {
      this.logger.error(`Failed to accept CallSession: ${e.message}`);
    }
  }

  // ==========================================
  // OUTBOUND WEBHOOK PROCESSING (PHASE 2 & 4)
  // ==========================================
  private async processOutboundProviderEvent(event: NormalizedCallEvent, req: any): Promise<boolean> {
    const raw = event.rawPayload || {};

    // Resolve the CallSession
    const session = await this.resolveExistingCallSessionFromProviderEvent(event);
    if (!session) {
      this.logger.warn(`[OUTBOUND-LIFECYCLE] Could not resolve CallSession for outbound webhook. SIPCallID=${raw.SIPCallID} CallUUID=${raw.CallUUID}`);
      return true; // Return true to ack webhook
    }

    this.logger.log(`[OUTBOUND-LIFECYCLE] Resolved CallSession ${session.id} for outbound webhook ${event.eventType}`);

    // Update transfer history with provider correlation IDs if this is the first webhook
    const th = (session.transferHistory as any) || {};
    th.providerCallUUID = raw.CallUUID || th.providerCallUUID;
    th.providerSIPCallID = raw.SIPCallID || th.providerSIPCallID;
    th.providerRequestID = raw.RequestID || th.providerRequestID;
    th.providerBridgeUUID = raw.BridgeUUID || th.providerBridgeUUID;

    await this.prisma.callSession.update({
      where: { id: session.id },
      data: { transferHistory: th }
    });

    if (event.eventType === 'CALL_ENDED' || event.eventType === 'CALL_MISSED' || event.eventType === 'CALL_FAILED') {
      const durationStr = raw.Duration || '0';
      const billsecStr = raw.Billsec || '0';
      const duration = parseInt(durationStr, 10);
      const billsec = parseInt(billsecStr, 10);

      // Determine MISSED vs ENDED based on answered state (billsec > 0 means answered)
      let finalStatus = session.status;
      if (billsec > 0 || session.status === 'IN_PROGRESS' || session.status === 'ENDED') {
        finalStatus = 'ENDED';
      } else {
        finalStatus = 'MISSED';
      }

      this.logger.log(`[OUTBOUND-LIFECYCLE] Call ended. billsec=${billsec}, finalStatus=${finalStatus}`);

      // DO NOT call endCallSession repeatedly. Update status directly if we are handling the provider webhook.
      // Wait, endCallSession is idempotent and handles LiveKit termination. We should call it, but pass the correct force flags.
      // Actually, endCallSession relies on `session.reason`. We can just call it to let it handle AI processing & cleanup.

      // But wait! endCallSession currently uses duration=0 -> MISSED. So we should pass the actual billsec as duration.
      await this.endCallSession(session.reason!, billsec > 0 ? billsec : duration, null, true);
    }

    return true;
  }

  private async resolveExistingCallSessionFromProviderEvent(event: NormalizedCallEvent) {
    const raw = event.rawPayload || {};
    const sipCallId = raw.SIPCallID;
    const requestId = raw.RequestID;
    const bridgeUuid = raw.BridgeUUID;
    const callUuid = raw.CallUUID || event.providerCallId;

    let session = null;

    // 1. Try to find by SIPCallID in transferHistory
    if (sipCallId) {
      const sessions = await this.prisma.callSession.findMany({
        where: { reason: { startsWith: 'call_outbound_' } },
        orderBy: { startedAt: 'desc' },
        take: 10
      });
      session = sessions.find(s => {
        const th = s.transferHistory as any;
        return th && th.providerSIPCallID === sipCallId;
      });
      if (session) return session;
    }

    // 2. Fallback to finding by providerCallId
    if (callUuid) {
      const sessions = await this.prisma.callSession.findMany({
        where: { reason: { startsWith: 'call_outbound_' } },
        orderBy: { startedAt: 'desc' },
        take: 10
      });
      session = sessions.find(s => {
        const th = s.transferHistory as any;
        return th && th.providerCallUUID === callUuid;
      });
      if (session) return session;
    }

    // 3. Fallback: Find the most recent active outbound call to this customer number
    const toNumber = raw.To || event.toNumber;
    if (toNumber && toNumber !== 'Unknown') {
      session = await this.prisma.callSession.findFirst({
        where: {
          reason: { startsWith: 'call_outbound_' },
          status: { in: ['RINGING', 'IN_PROGRESS'] },
          customer: { phone: { contains: toNumber.slice(-10) } }
        },
        orderBy: { startedAt: 'desc' }
      });
      if (session) return session;
    }

    // 4. Absolute fallback: Just get the most recent outbound call that is active
    session = await this.prisma.callSession.findFirst({
      where: {
        reason: { startsWith: 'call_outbound_' },
        status: { in: ['RINGING', 'IN_PROGRESS'] }
      },
      orderBy: { startedAt: 'desc' }
    });

    return session;
  }

  async startLivekitRecording(callSid: string, roomName: string) {
    let callSession: any = null;
    try {
      this.logger.log(`[CALL-RECORDING] provider=livekit_egress callId=${callSid} roomName=${roomName}`);
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callSid);
      callSession = await this.prisma.callSession.findFirst({
        where: {
          OR: [
            { livekitRoom: roomName },
            { reason: callSid },
            ...(isUuid ? [{ id: callSid }] : [])
          ]
        }
      });
      if (!callSession ||
        callSession.recordingStatus === 'RECORDING' ||
        callSession.recordingStatus === 'PROCESSING' ||
        callSession.recordingStatus === 'READY' ||
        callSession.livekitEgressId) {
        this.logger.log(`[CALL-RECORDING] Ignored START: already in progress or has egressId callSid=${callSid}`);
        return;
      }

      // Check participants with polling retry so we don't abort if the 2nd participant is still joining
      let participants = await this.livekitService.getRoomParticipants(roomName);
      this.logger.log(`[CALL-RECORDING] event=ROOM_PARTICIPANTS callId=${callSid} roomName=${roomName} participantCount=${participants.length} participants=${participants.map(p => p.identity).join(',')}`);

      if (participants.length < 2) {
        this.logger.log(`[CALL-RECORDING] Room has < 2 participants. Polling up to 15s for 2nd participant...`);
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1500));
          const current = await this.prisma.callSession.findUnique({ where: { id: callSession.id } });
          if (!current || current.status === 'ENDED' || current.status === 'MISSED') {
            this.logger.log(`[CALL-RECORDING] Call ended while waiting for participants. Aborting recording start.`);
            return;
          }
          participants = await this.livekitService.getRoomParticipants(roomName);
          if (participants.length >= 2) break;
        }
      }

      if (participants.length < 2) {
        this.logger.warn(`[CALL-RECORDING] Timed out waiting for 2nd participant in room ${roomName}.`);
        return;
      }

      this.logger.log(`[CALL-RECORDING] event=EGRESS_STARTING callId=${callSid} roomName=${roomName}`);
      const egressId = await this.livekitService.startRoomRecording(roomName);

      await this.prisma.callSession.update({
        where: { id: callSession.id },
        data: {
          recordingStatus: 'RECORDING',
          livekitEgressId: egressId,
          recordingStartedAt: new Date()
        }
      });
      this.logger.log(`[CALL-RECORDING] event=EGRESS_STARTED callId=${callSid} roomName=${roomName} egressId=${egressId}`);
    } catch (e: any) {
      this.logger.error(`[CALL-RECORDING] START failed: ${e.message}`);
      await this.prisma.callSession.update({
        where: { id: callSession.id },
        data: { recordingStatus: 'FAILED' }
      }).catch(() => {});
    }
  }

  async endCallSession(
    callSid: string,
    duration: number = 0,
    vobizRecordingUrl: string | null = null,
    forceCleanup: boolean = false,
  ) {
    this.logger.log(`Ending CallSession ${callSid} forceCleanup=${forceCleanup}`);
    try {
      const session = await this.prisma.callSession.findFirst({
        where: { reason: callSid },
        include: { participants: true },
      });
      if (!session) return;

      if (session.status === 'ENDED' || session.status === 'MISSED') {
        this.logger.log(`[CALL-LIFECYCLE] Session ${callSid} is already ${session.status}. Skipping duplicate endCallSession.`);
        return;
      }

      // Terminate SIP Participant in LiveKit (Idempotent)
      let terminationResult = 'not_applicable';
      if (session.livekitRoom) {
        terminationResult = await this.livekitService.terminateLiveKitCall(session.livekitRoom, callSid, session.livekitSipParticipantIdentity || undefined);
      }

      // If termination failed and this is an explicit user end, do not blindly end
      if (terminationResult === 'not_found' && !forceCleanup) {
        this.logger.log(`[CALL-LIFECYCLE] ` + JSON.stringify({
          event: 'termination_failed',
          sessionID: callSid,
          roomName: session.livekitRoom,
          reason: 'SIP Participant not found. Waiting for provider webhook to confirm termination.'
        }));
        return; // Wait for webhook
      }

      let finalDuration = duration;
      if ((!finalDuration || finalDuration <= 0) && session.createdAt) {
        const elapsed = Math.floor((Date.now() - new Date(session.createdAt).getTime()) / 1000);
        if (elapsed > 0 && session.status !== 'RINGING') {
          finalDuration = elapsed;
        }
      }

      const finalStatus = finalDuration === 0 && session.status === 'RINGING' ? 'MISSED' : 'ENDED';

      await this.prisma.callSession.update({
        where: { id: session.id },
        data: {
          endedAt: new Date(),
          duration: finalDuration,
          status: finalStatus,
          aiProcessingStatus: (finalStatus === 'ENDED' && (finalDuration > 0 || session.recordingStatus === 'RECORDING')) ? 'RECORDING_PENDING' : 'COMPLETED',
        },
      });

      const latestSession = await this.prisma.callSession.findUnique({ where: { id: session.id } }) || session;

      if (latestSession.livekitEgressId && (latestSession.recordingStatus === 'RECORDING' || latestSession.recordingStatus === 'PENDING')) {
        try {
          this.logger.log(`[CALL-RECORDING] event=EGRESS_STOP_REQUEST callId=${latestSession.id} roomName=${latestSession.livekitRoom} egressId=${latestSession.livekitEgressId}`);
          await this.livekitService.stopRoomRecording(latestSession.livekitEgressId);
          this.logger.log(`[CALL-RECORDING] event=EGRESS_STOPPED callId=${latestSession.id} egressId=${latestSession.livekitEgressId}`);
          await this.prisma.callSession.update({
            where: { id: latestSession.id },
            data: { recordingStatus: 'PROCESSING', recordingCompletedAt: new Date() }
          });
          // Process egress asynchronously
          this.processEgress(latestSession.livekitEgressId, latestSession.id, latestSession.livekitRoom || callSid).catch(console.error);
        } catch (e: any) {
          this.logger.error(`[CALL-RECORDING] Failed to stop egress: ${e.message}`);
          this.triggerPostCallPipeline(latestSession, null).catch(console.error);
        }
      } else if (finalStatus === 'ENDED' && finalDuration > 0) {
        // No egress was started or start failed, but call finished:
        if (!latestSession.recordingStatus || latestSession.recordingStatus === 'PENDING') {
          await this.prisma.callSession.update({
            where: { id: latestSession.id },
            data: { recordingStatus: 'NOT_AVAILABLE' }
          }).catch(() => {});
        }
        this.logger.log(`[CALL-RECORDING] No active egress for callId=${latestSession.id}. Triggering AI pipeline directly.`);
        this.triggerPostCallPipeline(latestSession, null).catch(console.error);
      }

      this.logger.log(`[CALL-LIFECYCLE] ` + JSON.stringify({
        event: 'session_marked_ended',
        sessionID: callSid,
        roomName: session.livekitRoom,
        currentCRMStatus: finalStatus,
        reason: 'endCallSession executed'
      }));

      // Mark agent as AVAILABLE again
      const agentParticipant = session.participants.find(
        (p: any) => p.role === 'AGENT' && p.agentId,
      );
      if (agentParticipant && agentParticipant.agentId) {
        await this.prisma.agent.update({
          where: { id: agentParticipant.agentId },
          data: { status: 'AVAILABLE', activeCalls: 0 },
        });

        await this.prisma.callParticipant.update({
          where: { id: agentParticipant.id },
          data: { leftAt: new Date() },
        });
      } else if (session.calleeUserId) {
        // If the call was missed/canceled before the agent accepted,
        // calleeUserId holds the User ID of the assigned agent. Release them!
        await this.prisma.agent.updateMany({
          where: { userId: session.calleeUserId },
          data: { status: 'AVAILABLE', activeCalls: 0 },
        });
      }
    } catch (e) {
      this.logger.error(`Failed to end CallSession: ${e.message}`);
    }
  }

  async getCallSessionRecordingUrl(callId: string): Promise<string | null> {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isUuid = UUID_REGEX.test(callId);
    const session = isUuid
      ? await this.prisma.callSession.findUnique({ where: { id: callId } })
      : await this.prisma.callSession.findFirst({ where: { OR: [{ reason: callId }, { livekitRoom: callId }] } });

    if (!session) {
      this.logger.log(`[CALL-RECORDING] event=PLAYBACK_LOOKUP callId=${callId} found=false`);
      return null;
    }

    this.logger.log(`[CALL-RECORDING] event=PLAYBACK_LOOKUP callId=${callId} recordingStatus=${session.recordingStatus} recordingStoragePath=${session.recordingStoragePath}`);

    if (session.recordingStatus !== 'READY') return null;

    if (session.recordingStoragePath) {
      const supabaseUrl = process.env.SUPABASE_URL || 'https://ftrwxsubjepdxssfuzls.supabase.co';
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy_key';
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(supabaseUrl, supabaseKey);

      const { data, error } = await supabase.storage
        .from('call-recordings')
        .createSignedUrl(session.recordingStoragePath, 3600);

      if (error) {
        this.logger.error(`[CALL-RECORDING] event=PLAYBACK_LOOKUP_ERROR callId=${callId} message="${error.message}"`);
        return session.recordingUrl || null;
      }
      return data?.signedUrl || null;
    }
    return session.recordingUrl || null;
  }

  async getDashboardCalls() {
    const allRinging = await this.prisma.callSession.findMany({
      where: { status: 'RINGING' },
      orderBy: { startedAt: 'desc' },
      include: {
        customer: { select: { name: true, phone: true } },
      },
    });

    const activeCalls = await this.prisma.callSession.findMany({
      where: { status: 'IN_PROGRESS' },
      orderBy: { startedAt: 'desc' },
      include: {
        customer: { select: { name: true, phone: true } },
        participants: {
          where: { role: 'AGENT' }
        }
      },
    });

    const allMissed = await this.prisma.callSession.findMany({
      where: { status: { in: ['MISSED', 'REJECTED'] } },
      orderBy: { startedAt: 'desc' },
      take: 20,
      include: {
        customer: { select: { name: true, phone: true } },
      },
    });

    // Filter purely inbound via transferHistory JSON
    const queuedCalls = allRinging.filter(c => (c.transferHistory as any)?.direction === 'inbound').slice(0, 5);
    const missedCalls = allMissed.filter(c => (c.transferHistory as any)?.direction === 'inbound').slice(0, 5);

    return { queuedCalls, missedCalls, activeCalls };
  }

  // Helper to get date boundaries for groupings using Asia/Kolkata timezone
  private getDateBoundaries() {
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth();
    let day = now.getDate();

    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now);
      const y = parts.find(p => p.type === 'year')?.value;
      const m = parts.find(p => p.type === 'month')?.value;
      const d = parts.find(p => p.type === 'day')?.value;
      if (y && m && d) {
        year = parseInt(y, 10);
        month = parseInt(m, 10) - 1;
        day = parseInt(d, 10);
      }
    } catch (_) {}

    const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
    const startOfToday = new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - IST_OFFSET_MS);
    const endOfToday = new Date(startOfToday.getTime() + 24 * 3600 * 1000 - 1);

    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 3600 * 1000);
    const endOfYesterday = new Date(startOfToday.getTime() - 1);

    const istDate = new Date(now.getTime() + IST_OFFSET_MS);
    const dayOfWeek = istDate.getUTCDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const startOfThisWeek = new Date(startOfToday.getTime() - daysSinceMonday * 24 * 3600 * 1000);
    const endOfEarlierThisWeek = new Date(startOfYesterday.getTime() - 1);

    const startOfPreviousWeeks = new Date(startOfThisWeek.getTime() - 21 * 24 * 3600 * 1000);
    const endOfPreviousWeeks = new Date(startOfThisWeek.getTime() - 1);

    return {
      now,
      startOfToday,
      endOfToday,
      startOfYesterday,
      endOfYesterday,
      startOfThisWeek,
      endOfEarlierThisWeek,
      startOfPreviousWeeks,
      endOfPreviousWeeks,
    };
  }

  private getGroupKeyForDate(date: Date, boundaries: any): 'today' | 'yesterday' | 'earlierThisWeek' | 'previousWeeks' | 'older' {
    const time = date.getTime();
    if (time >= boundaries.startOfToday.getTime()) return 'today';
    if (time >= boundaries.startOfYesterday.getTime()) return 'yesterday';
    if (time >= boundaries.startOfThisWeek.getTime()) return 'earlierThisWeek';
    if (time >= boundaries.startOfPreviousWeeks.getTime()) return 'previousWeeks';
    return 'older';
  }

  async getComprehensiveCallHistory(query: any = {}, user?: any) {
    const boundaries = this.getDateBoundaries();
    const page = Math.max(parseInt(query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * limit;
    const group = query.group || 'all';

    const isSuperAdmin = user?.role === 'SUPER_ADMIN';
    const isElevated = isSuperAdmin || ['ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user?.role);

    const where: any = {};

    // 1. Role Scope / Super Admin Cross-Unit Access
    if (!isElevated && user) {
      where.OR = [
        { callerUserId: user.userId || user.id },
        { calleeUserId: user.userId || user.id },
        {
          participants: {
            some: {
              OR: [
                { agentId: user.agentId },
                { agentId: user.id },
              ]
            }
          }
        }
      ];
    } else if (user && user.unitId && !isSuperAdmin) {
      where.OR = [
        { customer: { isNot: null } },
        { lead: { unitId: user.unitId } }
      ];
    }

    // 2. Date / Group Filter
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) where.createdAt.lte = new Date(query.endDate);
    } else if (group !== 'all') {
      if (group === 'today') {
        where.createdAt = { gte: boundaries.startOfToday, lte: boundaries.endOfToday };
      } else if (group === 'yesterday') {
        where.createdAt = { gte: boundaries.startOfYesterday, lte: boundaries.endOfYesterday };
      } else if (group === 'earlierThisWeek' || group === 'earlier_this_week') {
        where.createdAt = { gte: boundaries.startOfThisWeek, lte: boundaries.endOfEarlierThisWeek };
      } else if (group === 'previousWeeks' || group === 'previous_weeks') {
        where.createdAt = { gte: boundaries.startOfPreviousWeeks, lte: boundaries.endOfPreviousWeeks };
      } else if (group === 'older') {
        where.createdAt = { lt: boundaries.startOfPreviousWeeks };
      } else if (group === 'earlier') {
        where.createdAt = { lt: boundaries.startOfYesterday };
      }
    }

    // 3. Search Filter
    if (query.search && query.search.trim()) {
      const s = query.search.trim();
      where.AND = where.AND || [];
      where.AND.push({
        OR: [
          { reason: { contains: s, mode: 'insensitive' } },
          { livekitRoom: { contains: s, mode: 'insensitive' } },
          { customer: { name: { contains: s, mode: 'insensitive' } } },
          { customer: { phone: { contains: s } } },
          { lead: { customerName: { contains: s, mode: 'insensitive' } } },
          { lead: { phoneNumber: { contains: s } } },
        ]
      });
    }

    // 4. Specific Filters
    if (query.agentId) {
      where.participants = {
        some: {
          agentId: query.agentId,
          role: 'AGENT'
        }
      };
    }

    if (query.direction) {
      const dir = query.direction.toUpperCase();
      if (dir === 'OUTBOUND') {
        where.reason = { startsWith: 'call_outbound_' };
      } else if (dir === 'INBOUND') {
        where.NOT = { reason: { startsWith: 'call_outbound_' } };
      }
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.department) {
      where.caller = { agentProfile: { department: query.department } };
    }

    if (query.foundation) {
      where.lead = { ...where.lead, foundation: query.foundation };
    }

    if (query.service || query.primaryService) {
      where.lead = { ...where.lead, primaryService: query.service || query.primaryService };
    }

    if (query.durationMin != null || query.durationMax != null) {
      where.duration = {};
      if (query.durationMin != null) where.duration.gte = parseInt(query.durationMin, 10);
      if (query.durationMax != null) where.duration.lte = parseInt(query.durationMax, 10);
    }

    if (query.leadId) {
      where.leadId = query.leadId;
    }

    if (query.recordingAvailable === 'true') {
      where.recordingStatus = 'READY';
    } else if (query.recordingAvailable === 'false') {
      where.recordingStatus = { not: 'READY' };
    }

    if (query.transferStatus === 'TRANSFERRED') {
      where.transferAudits = { some: {} };
    } else if (query.transferStatus === 'NOT_TRANSFERRED') {
      where.transferAudits = { none: {} };
    }

    // Today's scope for header KPIs
    const todayWhereScope = {
      ...where,
      createdAt: { gte: boundaries.startOfToday, lte: boundaries.endOfToday }
    };

    // 5. Query DB with pagination, grouping counts, and real today KPIs
    const [
      total,
      records,
      todayCount,
      yesterdayCount,
      earlierCount,
      prevWeeksCount,
      olderCount,
      todayTotalCalls,
      todayConnectedCalls,
      todayMissedCalls,
      todayOutboundCalls,
      todayInboundCalls,
      todayTransferredCalls,
    ] = await Promise.all([
      this.prisma.callSession.count({ where }),
      this.prisma.callSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          customer: { select: { id: true, name: true, phone: true, email: true, instagramUsername: true } },
          lead: {
            select: {
              id: true,
              customerName: true,
              phoneNumber: true,
              email: true,
              priority: true,
              status: true,
              source: true,
              foundation: true,
              primaryService: true,
              subServices: true,
              isAmbulanceEmergency: true,
            }
          },
          caller: { select: { id: true, email: true, agentProfile: { select: { id: true, name: true, department: true } } } },
          callee: { select: { id: true, email: true, agentProfile: { select: { id: true, name: true, department: true } } } },
          participants: {
            orderBy: { joinedAt: 'asc' },
          },
          transferAudits: {
            orderBy: { createdAt: 'desc' },
            include: {
              initiatingAgent: { select: { id: true, name: true, department: true } },
              destinationAgent: { select: { id: true, name: true, department: true } },
            }
          },
          analytics: true,
          conversation: {
            select: {
              id: true,
              channel: true,
              foundation: true,
              primaryService: true,
              aiSummary: true,
            }
          }
        }
      }),
      this.prisma.callSession.count({ where: { ...where, createdAt: { gte: boundaries.startOfToday, lte: boundaries.endOfToday } } }),
      this.prisma.callSession.count({ where: { ...where, createdAt: { gte: boundaries.startOfYesterday, lte: boundaries.endOfYesterday } } }),
      this.prisma.callSession.count({ where: { ...where, createdAt: { gte: boundaries.startOfThisWeek, lte: boundaries.endOfEarlierThisWeek } } }),
      this.prisma.callSession.count({ where: { ...where, createdAt: { gte: boundaries.startOfPreviousWeeks, lte: boundaries.endOfPreviousWeeks } } }),
      this.prisma.callSession.count({ where: { ...where, createdAt: { lt: boundaries.startOfPreviousWeeks } } }),
      // Module 1.2 Required KPIs (Asia/Kolkata today)
      this.prisma.callSession.count({ where: todayWhereScope }),
      this.prisma.callSession.count({
        where: {
          ...todayWhereScope,
          OR: [
            { status: 'CONNECTED' },
            { status: 'ENDED', duration: { gt: 0 } }
          ]
        }
      }),
      this.prisma.callSession.count({
        where: {
          ...todayWhereScope,
          status: 'MISSED',
          NOT: { reason: { startsWith: 'call_outbound_' } }
        }
      }),
      this.prisma.callSession.count({
        where: {
          ...todayWhereScope,
          reason: { startsWith: 'call_outbound_' }
        }
      }),
      this.prisma.callSession.count({
        where: {
          ...todayWhereScope,
          NOT: { reason: { startsWith: 'call_outbound_' } }
        }
      }),
      this.prisma.callSession.count({
        where: {
          ...todayWhereScope,
          OR: [
            { status: 'TRANSFERRED' },
            { transferAudits: { some: {} } }
          ]
        }
      }),
    ]);

    const jwt = require('jsonwebtoken');
    const jwtSecret = process.env.JWT_SECRET || 'crm-secure-jwt-secret-key-2026';
    const baseUrl = process.env.BASE_URL || 'https://crm-uec-backend.onrender.com';

    const calls = await Promise.all(records.map(async (r) => {
      const summaryObj = r.conversation?.aiSummary;
      const aiSummary = summaryObj ? (Array.isArray(summaryObj) ? summaryObj[0] : summaryObj) : null;
      const analytics = r.analytics;

      let tokenQuery = '';
      if (r.recordingStatus === 'READY' && user && (user.userId || user.id || user.sub)) {
        try {
          const token = jwt.sign(
            {
              sub: user.userId || user.id || user.sub,
              userId: user.userId || user.id || user.sub,
              role: user.role,
              callId: r.id
            },
            jwtSecret,
            { expiresIn: '2h' }
          );
          tokenQuery = `?token=${token}`;
        } catch (_) {}
      }

      const firstAgentPart = r.participants.find(p => p.role === 'AGENT');
      let handlingAgentName = 'Unassigned';
      let handlingAgentId = firstAgentPart?.agentId || null;
      let department = 'General';

      if (firstAgentPart?.agentId) {
        const ag = await this.prisma.agent.findUnique({
          where: { id: firstAgentPart.agentId },
          select: { name: true, department: true }
        });
        if (ag) {
          handlingAgentName = ag.name;
          department = ag.department || 'General';
        }
      } else if (r.caller?.agentProfile) {
        handlingAgentName = r.caller.agentProfile.name;
        handlingAgentId = r.caller.agentProfile.id;
        department = r.caller.agentProfile.department || 'General';
      }

      const isOutbound = r.reason?.startsWith('call_outbound_') || (r.transferHistory as any)?.direction === 'outbound';
      const callDate = r.startedAt || r.createdAt;
      const groupKey = this.getGroupKeyForDate(callDate, boundaries);

      const totalDuration = r.duration || 0;
      const connectedDuration = r.endedAt && r.startedAt
        ? Math.max(Math.round((r.endedAt.getTime() - r.startedAt.getTime()) / 1000), 0)
        : totalDuration;

      const intakeData = (r.intakeForm as any) || {};

      // Contact and omnichannel eligibility
      const phone = r.customer?.phone || r.lead?.phoneNumber || (r.transferHistory as any)?.phone;
      const email = r.customer?.email || r.lead?.email;
      const instagram = (r.customer as any)?.instagramUsername;

      const availableChannels: any[] = [];
      if (phone) {
        availableChannels.push({ channel: 'WHATSAPP', label: 'WhatsApp', destination: phone, isValid: true });
      }
      if (email) {
        availableChannels.push({ channel: 'EMAIL', label: 'Email', destination: email, isValid: true });
      }
      if (instagram) {
        availableChannels.push({ channel: 'INSTAGRAM', label: 'Instagram', destination: instagram, isValid: true });
      }

      const requiredService = r.lead?.primaryService || (r.intakeForm as any)?.primaryService || r.conversation?.primaryService || 'Doctor at Home';
      const subServices = r.lead?.subServices || (r.intakeForm as any)?.subServices || [];
      const source = isOutbound ? 'Outbound Call' : (r.lead?.source || (r.transferHistory as any)?.sourceChannel || 'Inbound Call');
      const foundation = r.lead?.foundation || r.conversation?.foundation || 'Elder Care';

      return {
        id: r.id,
        callSid: r.reason || r.id,
        providerCallId: (r.transferHistory as any)?.providerCallUUID || r.reason || r.id,
        livekitRoom: r.livekitRoom,
        callerName: r.customer?.name || r.lead?.customerName || (isOutbound ? 'Agent' : 'Unknown Caller'),
        callerPhone: phone || 'Unknown',
        customerEmail: email || null,
        leadId: r.lead?.id || r.leadId || null,
        leadName: r.lead?.customerName || null,
        direction: isOutbound ? 'OUTBOUND' : 'INBOUND',
        startedAt: r.startedAt ? r.startedAt.toISOString() : r.createdAt.toISOString(),
        endedAt: r.endedAt ? r.endedAt.toISOString() : null,
        duration: totalDuration,
        connectedDuration,
        status: r.status,
        handlingAgent: { id: handlingAgentId, name: handlingAgentName },
        originalAgent: r.caller?.agentProfile || { id: handlingAgentId, name: handlingAgentName },
        department,
        requiredService,
        subServices,
        source,
        foundation,
        availableChannels,
        customerDetails: {
          id: r.customer?.id || null,
          name: r.customer?.name || r.lead?.customerName || 'Unknown',
          phone,
          email,
        },
        conversationId: r.conversationId || null,
        isTransferred: (r.transferAudits?.length || 0) > 0,
        transferCount: r.transferAudits?.length || 0,
        transfers: r.transferAudits,
        recordingStatus: r.recordingStatus || 'NOT_AVAILABLE',
        recordingUrl: r.recordingStatus === 'READY' ? `${baseUrl}/telephony/calls/${r.id}/recording${tokenQuery}` : null,
        recordingDuration: r.recordingDuration || totalDuration,
        disposition: intakeData.callOutcome || analytics?.callOutcome || (r.status === 'MISSED' ? 'Missed Call' : 'Completed'),
        priority: r.lead?.isAmbulanceEmergency ? 'EMERGENCY' : (r.lead?.priority || 'NORMAL'),
        summary: analytics?.summary || aiSummary?.summaryText || (r.liveNotes as any)?.notes || null,
        sentiment: analytics?.sentiment || aiSummary?.sentimentScore || null,
        groupKey,
      };
    }));

    return {
      calls,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
      groupCounts: {
        today: todayCount,
        yesterday: yesterdayCount,
        earlierThisWeek: earlierCount,
        previousWeeks: prevWeeksCount,
        older: olderCount,
        earlierDates: earlierCount + prevWeeksCount + olderCount,
      },
      todayKpis: {
        totalCallsToday: todayTotalCalls,
        totalConnectedToday: todayConnectedCalls,
        totalMissedToday: todayMissedCalls,
        totalOutboundToday: todayOutboundCalls,
        totalInboundToday: todayInboundCalls,
        totalTransferredToday: todayTransferredCalls,
      },
      summary: {
        totalCalls: total,
        connectedCalls: calls.filter(c => c.status === 'CONNECTED' || c.status === 'ENDED').length,
        missedCalls: calls.filter(c => c.status === 'MISSED').length,
      }
    };
  }

  async getCallRecordDetail(callId: string, user?: any) {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isUuid = UUID_REGEX.test(callId);

    const session = isUuid
      ? await this.prisma.callSession.findUnique({
          where: { id: callId },
          include: {
            customer: true,
            lead: {
              include: {
                followups: { orderBy: { followupDate: 'desc' }, take: 3 },
                assignedAgent: true,
              }
            },
            caller: { include: { agentProfile: true } },
            callee: { include: { agentProfile: true } },
            participants: true,
            transferAudits: {
              include: {
                initiatingAgent: true,
                destinationAgent: true,
              },
              orderBy: { createdAt: 'asc' }
            },
            analytics: true,
            conversation: { include: { aiSummary: true } },
            appointments: true,
          }
        })
      : await this.prisma.callSession.findFirst({
          where: { OR: [{ reason: callId }, { livekitRoom: callId }] },
          include: {
            customer: true,
            lead: {
              include: {
                followups: { orderBy: { followupDate: 'desc' }, take: 3 },
                assignedAgent: true,
              }
            },
            caller: { include: { agentProfile: true } },
            callee: { include: { agentProfile: true } },
            participants: true,
            transferAudits: {
              include: {
                initiatingAgent: true,
                destinationAgent: true,
              },
              orderBy: { createdAt: 'asc' }
            },
            analytics: true,
            conversation: { include: { aiSummary: true } },
            appointments: true,
          }
        });

    if (!session) {
      throw new NotFoundException(`Call record not found for ID: ${callId}`);
    }

    const isSuperAdmin = user?.role === 'SUPER_ADMIN';
    const isElevated = isSuperAdmin || ['ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user?.role);
    if (!isElevated && user) {
      const isCaller = session.callerUserId === user.userId || session.callerUserId === user.id;
      const isCallee = session.calleeUserId === user.userId || session.calleeUserId === user.id;
      const isParticipant = session.participants?.some(p => p.agentId === user.agentId || p.agentId === user.id);
      if (!isCaller && !isCallee && !isParticipant) {
        throw new ForbiddenException('Forbidden: You do not have permission to view this call record');
      }
    }

    const jwt = require('jsonwebtoken');
    const jwtSecret = process.env.JWT_SECRET || 'crm-secure-jwt-secret-key-2026';
    const baseUrl = process.env.BASE_URL || 'https://crm-uec-backend.onrender.com';
    let tokenQuery = '';
    if (session.recordingStatus === 'READY' && user && (user.userId || user.id || user.sub)) {
      try {
        const token = jwt.sign(
          {
            sub: user.userId || user.id || user.sub,
            userId: user.userId || user.id || user.sub,
            role: user.role,
            callId: session.id,
          },
          jwtSecret,
          { expiresIn: '2h' }
        );
        tokenQuery = `?token=${token}`;
      } catch (_) {}
    }

    const intake = (session.intakeForm as any) || {};
    const liveNotes = (session.liveNotes as any) || {};
    const isOutbound = session.reason?.startsWith('call_outbound_') || (session.transferHistory as any)?.direction === 'outbound';

    const timelineEvents: Array<{
      id: string;
      title: string;
      type: string;
      timestamp: string;
      description: string;
      actor?: string;
    }> = [];

    timelineEvents.push({
      id: 'event-initiated',
      title: 'Call Initiated',
      type: 'INITIATED',
      timestamp: (session.startedAt || session.createdAt).toISOString(),
      description: `${isOutbound ? 'Outbound call started' : 'Inbound call received'} via ${session.livekitRoom ? 'LiveKit SIP' : 'Telephony'}`,
      actor: isOutbound ? (session.caller?.agentProfile?.name || 'Agent') : (session.customer?.name || 'Customer'),
    });

    timelineEvents.push({
      id: 'event-ringing',
      title: 'Call Ringing',
      type: 'RINGING',
      timestamp: session.createdAt.toISOString(),
      description: 'Call dispatched to agents queue',
      actor: 'System',
    });

    if (session.participants && session.participants.length > 0) {
      const firstJoin = session.participants[0];
      timelineEvents.push({
        id: 'event-answered',
        title: 'Call Answered & Connected',
        type: 'ANSWERED',
        timestamp: firstJoin.joinedAt.toISOString(),
        description: 'Agent joined room and audio stream connected',
        actor: session.caller?.agentProfile?.name || session.callee?.agentProfile?.name || 'Agent',
      });
    }

    for (const tr of session.transferAudits) {
      timelineEvents.push({
        id: `event-transfer-init-${tr.id}`,
        title: `Call Transfer Initiated (${tr.transferMode})`,
        type: 'TRANSFER_INITIATED',
        timestamp: tr.initiatedAt.toISOString(),
        description: `Transfer from ${tr.sourceDepartment || 'Agent'} to ${tr.destDepartment || 'Department'}${tr.reason ? `: ${tr.reason}` : ''}`,
        actor: tr.initiatingAgent?.name || 'Agent',
      });

      if (tr.completedAt) {
        timelineEvents.push({
          id: `event-transfer-comp-${tr.id}`,
          title: `Transfer ${tr.status}`,
          type: `TRANSFER_${tr.status}`,
          timestamp: tr.completedAt.toISOString(),
          description: tr.status === 'COMPLETED'
            ? `Successfully transferred to ${tr.destinationAgent?.name || 'Destination Agent'}`
            : `Transfer failed/cancelled: ${tr.failureReason || 'Not completed'}`,
          actor: tr.destinationAgent?.name || 'System',
        });
      }
    }

    if (session.endedAt) {
      timelineEvents.push({
        id: 'event-ended',
        title: 'Call Ended',
        type: 'ENDED',
        timestamp: session.endedAt.toISOString(),
        description: `Call duration: ${session.duration || 0} seconds with final status ${session.status}`,
        actor: 'Telephony',
      });
    }

    if (session.recordingStatus && session.recordingStatus !== 'NOT_AVAILABLE') {
      timelineEvents.push({
        id: 'event-recording',
        title: `Recording ${session.recordingStatus}`,
        type: 'RECORDING',
        timestamp: (session.recordingCompletedAt || session.endedAt || session.createdAt).toISOString(),
        description: session.recordingStatus === 'READY'
          ? `Audio recording stored (${session.recordingDuration || session.duration || 0}s, ${session.recordingMimeType || 'audio/mp4'})`
          : `Recording state: ${session.recordingStatus}`,
        actor: 'Egress / LiveKit',
      });
    }

    if (session.analytics?.createdAt) {
      timelineEvents.push({
        id: 'event-ai-summary',
        title: 'AI Summary Generated',
        type: 'AI_SUMMARY',
        timestamp: session.analytics.createdAt.toISOString(),
        description: session.analytics.summary
          ? `Analysis complete: Sentiment=${session.analytics.sentiment || 'Neutral'}`
          : 'AI processing complete',
        actor: 'Gemini AI Engine',
      });
    }

    if (session.lead?.followups && session.lead.followups.length > 0) {
      const fu = session.lead.followups[0];
      timelineEvents.push({
        id: `event-followup-${fu.id}`,
        title: 'Follow-up Scheduled',
        type: 'FOLLOW_UP',
        timestamp: fu.createdAt.toISOString(),
        description: `Callback scheduled for ${fu.followupDate.toISOString().split('T')[0]} (${fu.meetingType})`,
        actor: session.lead.assignedAgent?.name || 'Agent',
      });
    }

    timelineEvents.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return {
      overview: {
        id: session.id,
        providerCallId: (session.transferHistory as any)?.providerCallUUID || session.reason || session.id,
        livekitRoom: session.livekitRoom,
        direction: isOutbound ? 'OUTBOUND' : 'INBOUND',
        status: session.status,
        duration: session.duration || 0,
        holdDuration: session.holdDuration || 0,
        startedAt: session.startedAt?.toISOString() || session.createdAt.toISOString(),
        endedAt: session.endedAt?.toISOString() || null,
        caller: {
          name: session.customer?.name || session.lead?.customerName || (isOutbound ? 'Agent' : 'Unknown'),
          phone: session.customer?.phone || session.lead?.phoneNumber || 'Unknown',
        },
        recipient: {
          name: isOutbound ? (session.customer?.name || session.lead?.customerName || 'Customer') : (session.caller?.agentProfile?.name || 'Call Center'),
          phone: isOutbound ? (session.customer?.phone || session.lead?.phoneNumber || 'Unknown') : 'Inbound Line',
        },
        lead: session.lead ? {
          id: session.lead.id,
          name: session.lead.customerName,
          phone: session.lead.phoneNumber,
          priority: session.lead.priority,
          status: session.lead.status,
          foundation: session.lead.foundation,
          primaryService: session.lead.primaryService,
          isAmbulanceEmergency: session.lead.isAmbulanceEmergency,
        } : null,
        handlingAgent: session.caller?.agentProfile || session.callee?.agentProfile || null,
        transfers: session.transferAudits,
      },
      recording: {
        status: session.recordingStatus || 'NOT_AVAILABLE',
        url: session.recordingStatus === 'READY' ? `${baseUrl}/telephony/calls/${session.id}/recording${tokenQuery}` : null,
        duration: session.recordingDuration || session.duration || 0,
        mimeType: session.recordingMimeType || 'audio/mp4',
        fileSize: session.recordingFileSize || null,
        failureReason: session.recordingStatus === 'FAILED' ? 'Audio stream capture or egress failed' : null,
      },
      aiSummary: {
        summaryText: session.analytics?.summary || (session.conversation?.aiSummary as any)?.summaryText || null,
        sentiment: session.analytics?.sentiment || (session.conversation?.aiSummary as any)?.sentimentScore || 'NEUTRAL',
        riskLevel: (session.conversation?.aiSummary as any)?.riskLevel || 'LOW',
        language: session.analytics?.language || 'en-IN',
        isTranscriptDerived: Boolean(session.analytics?.transcript || session.analytics?.aiHandling),
        transcript: session.analytics?.transcript || null,
      },
      notesAndDisposition: {
        agentNotes: liveNotes.notes || intake.notes || null,
        intakeForm: intake,
        callOutcome: intake.callOutcome || session.analytics?.callOutcome || (session.status === 'MISSED' ? 'MISSED' : 'COMPLETED'),
        csatScore: intake.csatScore || 5,
        followupDate: session.lead?.followups?.[0]?.followupDate?.toISOString() || null,
        callbackStatus: session.lead?.followups?.[0]?.status || 'NONE',
      },
      timeline: timelineEvents,
    };
  }

  async getDepartmentsAndAgents() {
    const departments = await this.prisma.department.findMany({
      include: {
        agents: {
          where: { isDeleted: false },
          select: {
            id: true,
            name: true,
            department: true,
            status: true,
            activeCalls: true,
            extension: true,
            skills: true,
          }
        }
      }
    });

    const allActiveAgents = await this.prisma.agent.findMany({
      where: { isDeleted: false },
      select: {
        id: true,
        name: true,
        department: true,
        status: true,
        activeCalls: true,
        extension: true,
        skills: true,
      }
    });

    return {
      departments: departments.map(d => ({
        id: d.id,
        name: d.name,
        description: d.description,
        agents: d.agents,
        totalAgents: d.agents.length,
        availableAgents: d.agents.filter(a => a.status === 'AVAILABLE').length,
      })),
      allAgents: allActiveAgents,
    };
  }

  async initiateCallTransfer(callSid: string, body: any, user: any) {
    this.logger.log(`[CALL-TRANSFER] Initiating transfer for callSid=${callSid} by user=${user?.userId || user?.sub}`);
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isUuid = UUID_REGEX.test(callSid);

    const session = isUuid
      ? await this.prisma.callSession.findUnique({
          where: { id: callSid },
          include: { customer: true, lead: true, participants: true }
        })
      : await this.prisma.callSession.findFirst({
          where: { OR: [{ reason: callSid }, { livekitRoom: callSid }] },
          include: { customer: true, lead: true, participants: true }
        });

    if (!session) {
      throw new NotFoundException(`Call session not found: ${callSid}`);
    }

    let initiatingAgent = null;
    if (user?.agentId) {
      initiatingAgent = await this.prisma.agent.findUnique({ where: { id: user.agentId } });
    }
    if (!initiatingAgent && (user?.userId || user?.id || user?.sub)) {
      initiatingAgent = await this.prisma.agent.findFirst({
        where: { userId: user.userId || user.id || user.sub }
      });
    }
    const firstAgentParticipant = session.participants.find(p => p.role === 'AGENT' && p.agentId);
    if (!initiatingAgent && firstAgentParticipant?.agentId) {
      initiatingAgent = await this.prisma.agent.findUnique({
        where: { id: firstAgentParticipant.agentId }
      });
    }

    if (!initiatingAgent) {
      throw new BadRequestException('Initiating agent profile could not be resolved');
    }

    const { destinationDepartment, destinationAgentId, transferMode = 'BLIND', reason } = body;

    let destinationAgent = null;
    if (destinationAgentId) {
      destinationAgent = await this.prisma.agent.findUnique({ where: { id: destinationAgentId } });
    } else if (destinationDepartment) {
      destinationAgent = await this.prisma.agent.findFirst({
        where: {
          department: { contains: destinationDepartment, mode: 'insensitive' },
          status: 'AVAILABLE',
          isDeleted: false,
        }
      });
    }

    if (!destinationAgent) {
      throw new BadRequestException(`No available agent found for department "${destinationDepartment || 'Requested'}"`);
    }

    const roomName = session.livekitRoom || `room_${session.id}`;
    let destToken = '';
    try {
      destToken = await this.livekitService.generateAgentToken(roomName, destinationAgent.name);
    } catch (e) {
      this.logger.warn(`Could not generate LiveKit token for transfer: ${e.message}`);
    }

    const transferAudit = await this.prisma.callTransferAudit.create({
      data: {
        callSessionId: session.id,
        initiatingAgentId: initiatingAgent.id,
        destinationAgentId: destinationAgent.id,
        sourceDepartment: initiatingAgent.department || 'General',
        destDepartment: destinationDepartment || destinationAgent.department || 'General',
        transferMode: transferMode === 'ATTENDED' ? 'ATTENDED' : 'BLIND',
        status: transferMode === 'ATTENDED' ? 'CONSULTING' : 'INITIATED',
        reason: reason || 'Live Call Transfer',
        metadata: {
          roomName,
          customerPhone: session.customer?.phone || session.lead?.phoneNumber,
          customerName: session.customer?.name || session.lead?.customerName,
        }
      },
      include: {
        initiatingAgent: { select: { id: true, name: true, department: true } },
        destinationAgent: { select: { id: true, name: true, department: true } },
      }
    });

    if (destinationAgent.socketId) {
      this.telephonyGateway.server.to(destinationAgent.socketId).emit('incoming_call', {
        callSid: session.reason || session.id,
        roomName,
        caller: session.customer?.phone || session.lead?.phoneNumber || 'Customer',
        phone: session.customer?.phone || session.lead?.phoneNumber || 'Customer',
        customerName: session.customer?.name || session.lead?.customerName || 'Customer',
        isTransfer: true,
        transferAuditId: transferAudit.id,
        transferMode,
        transferReason: reason,
        sourceAgent: {
          id: initiatingAgent.id,
          name: initiatingAgent.name,
          department: initiatingAgent.department,
        },
        token: destToken,
      });
    } else {
      this.telephonyGateway.server.emit('incoming_call_transfer', {
        destinationAgentId: destinationAgent.id,
        destinationDepartment: destinationAgent.department,
        callSid: session.reason || session.id,
        roomName,
        token: destToken,
        transferAuditId: transferAudit.id,
      });
    }

    this.telephonyGateway.server.emit('callTransferInitiated', {
      callSessionId: session.id,
      callSid: session.reason || session.id,
      transferAuditId: transferAudit.id,
      status: transferAudit.status,
      destinationAgent: { id: destinationAgent.id, name: destinationAgent.name },
    });

    return {
      success: true,
      transferAudit,
      roomName,
      destinationAgent: {
        id: destinationAgent.id,
        name: destinationAgent.name,
        department: destinationAgent.department,
      }
    };
  }

  async completeCallTransfer(callSid: string, body: any, user: any) {
    this.logger.log(`[CALL-TRANSFER] Completing transfer for callSid=${callSid}`);
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isUuid = UUID_REGEX.test(callSid);

    const session = isUuid
      ? await this.prisma.callSession.findUnique({
          where: { id: callSid },
          include: { transferAudits: { orderBy: { createdAt: 'desc' }, take: 1 } }
        })
      : await this.prisma.callSession.findFirst({
          where: { OR: [{ reason: callSid }, { livekitRoom: callSid }] },
          include: { transferAudits: { orderBy: { createdAt: 'desc' }, take: 1 } }
        });

    if (!session) {
      throw new NotFoundException(`Call session not found: ${callSid}`);
    }

    const latestAudit = session.transferAudits[0];
    if (latestAudit) {
      await this.prisma.callTransferAudit.update({
        where: { id: latestAudit.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
        }
      });

      if (latestAudit.destinationAgentId) {
        await this.prisma.callParticipant.create({
          data: {
            callSessionId: session.id,
            agentId: latestAudit.destinationAgentId,
            role: 'AGENT',
            joinedAt: new Date(),
          }
        });
      }
    }

    await this.prisma.callSession.update({
      where: { id: session.id },
      data: {
        status: 'TRANSFERRED',
      }
    });

    this.telephonyGateway.server.emit('callTransferCompleted', {
      callSessionId: session.id,
      callSid: session.reason || session.id,
      transferAuditId: latestAudit?.id,
    });

    return { success: true, message: 'Transfer completed successfully' };
  }

  async cancelCallTransfer(callSid: string, body: any, user: any) {
    this.logger.log(`[CALL-TRANSFER] Cancelling transfer for callSid=${callSid}`);
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isUuid = UUID_REGEX.test(callSid);

    const session = isUuid
      ? await this.prisma.callSession.findUnique({
          where: { id: callSid },
          include: { transferAudits: { orderBy: { createdAt: 'desc' }, take: 1 } }
        })
      : await this.prisma.callSession.findFirst({
          where: { OR: [{ reason: callSid }, { livekitRoom: callSid }] },
          include: { transferAudits: { orderBy: { createdAt: 'desc' }, take: 1 } }
        });

    if (!session) {
      throw new NotFoundException(`Call session not found: ${callSid}`);
    }

    const latestAudit = session.transferAudits[0];
    if (latestAudit && latestAudit.status !== 'COMPLETED') {
      await this.prisma.callTransferAudit.update({
        where: { id: latestAudit.id },
        data: {
          status: 'CANCELLED',
          failureReason: body?.reason || 'Cancelled by agent',
        }
      });
    }

    this.telephonyGateway.server.emit('callTransferCancelled', {
      callSessionId: session.id,
      callSid: session.reason || session.id,
      transferAuditId: latestAudit?.id,
    });

    return { success: true, message: 'Transfer cancelled' };
  }

  async getTransferAudits(query: any = {}, user?: any) {
    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.department) where.destDepartment = query.department;
    if (query.agentId) {
      where.OR = [
        { initiatingAgentId: query.agentId },
        { destinationAgentId: query.agentId },
      ];
    }

    return await this.prisma.callTransferAudit.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        initiatingAgent: { select: { id: true, name: true, department: true } },
        destinationAgent: { select: { id: true, name: true, department: true } },
        callSession: {
          select: {
            id: true,
            status: true,
            duration: true,
            customer: { select: { name: true, phone: true } },
            lead: { select: { customerName: true, phoneNumber: true } },
          }
        }
      }
    });
  }

  async getCallHistory(user?: any) {
    const result = await this.getComprehensiveCallHistory({ limit: 50 }, user);
    return result.calls;
  }

  async getMyRingingCall(agentId: string) {
    if (!agentId) return null;
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(agentId)) {
      return null;
    }

    // Find a ringing call session assigned to this agent
    const callSession = await this.prisma.callSession.findFirst({
      where: {
        status: 'RINGING',
        participants: {
          some: { agentId: agentId, role: 'AGENT' },
        },
      },
      include: { customer: true, participants: true },
    });

    if (!callSession) return null;

    // Generate token
    const agent = await this.prisma.agent.findUnique({
      where: { userId: agentId },
    });
    if (!agent) return null;

    const { LivekitService } = require('./livekit.service');
    // We cannot easily inject LivekitService here due to circular dependency, so we will generate token manually or pass it in.
    // Wait, let's just do it in the controller which has access to LivekitService!

    return { callSession, agent };
  }

  private async processEgress(egressId: string, sessionId: string, roomName: string) {
    let retries = 0;
    while (retries < 20) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const info = await this.livekitService.getEgressInfo(egressId);
        if (info) {
          this.logger.log(`[CALL-RECORDING] event=EGRESS_STATUS callId=${sessionId} egressId=${egressId} status=${info.status}`);
          if (info.status === 3) { // EGRESS_COMPLETE
            this.logger.log(`[CALL-RECORDING] event=EGRESS_COMPLETE callId=${sessionId} egressId=${egressId}`);

            let egressFile = null;
            if ((info as any).result?.case === 'file' && (info as any).result?.value) {
              egressFile = (info as any).result.value;
            } else if (info.fileResults && info.fileResults.length > 0) {
              egressFile = info.fileResults[0];
            } else if (info.file) {
              egressFile = info.file;
            }

            let fallbackPath = '';
            if (!egressFile || (!egressFile.location && !egressFile.filename)) {
              const requestValue = (info as any).request?.value;
              if (requestValue?.fileOutputs?.length > 0) {
                fallbackPath = requestValue.fileOutputs[0].filepath || '';
                if (fallbackPath) {
                  egressFile = { filename: fallbackPath, location: '', size: 0, duration: 0 };
                }
              }
            }

            this.logger.log(`[CALL-RECORDING] event=EGRESS_FILE_RESULT callId=${sessionId} egressId=${egressId} fileCount=${info.fileResults?.length || 0} filename=${egressFile?.filename} location=${egressFile?.location} fallbackPath=${fallbackPath} size=${egressFile?.size} duration=${egressFile?.duration}`);


            let finalPath = '';
            if (egressFile && (egressFile.location || egressFile.filename)) {
              finalPath = egressFile.filename || egressFile.location;
            }
            if (!finalPath) {
              finalPath = `recordings/${roomName}.mp4`;
            }

            const s3Bucket = process.env.EGRESS_S3_BUCKET;

            // If it's already in the final Supabase bucket, we don't need to re-upload.
            if (s3Bucket === 'call-recordings') {
              this.logger.log(`[CALL-RECORDING] Egress already uploaded to Supabase S3 bucket: ${s3Bucket}`);
              // We still want to trigger the pipeline and mark ready.
            } else {
              // It's in a temporary bucket, so we download and upload to Supabase
              const result = await this.uploadLivekitEgressToSupabase(finalPath, roomName, sessionId);
              if (result) {
                finalPath = result.path;
              } else {
                throw new Error('Failed to upload to Supabase');
              }
            }

            await this.prisma.callSession.update({
              where: { id: sessionId },
              data: {
                recordingStatus: 'READY',
                recordingStoragePath: finalPath,
                recordingFileSize: egressFile ? Number(egressFile.size || 0) : 0,
                recordingDuration: egressFile ? Math.floor(Number(egressFile.duration || 0) / 1000000000) : 0
              }
            });
            this.logger.log(`[CALL-RECORDING] Egress processed and READY for sessionId=${sessionId}`);
            const session = await this.prisma.callSession.findUnique({ where: { id: sessionId } });
            if (session) {
              this.triggerPostCallPipeline(session, finalPath).catch(console.error);
            }
            break;
          } else if (info.status > 3) { // 4 FAILED, 5 ABORTED, 6 LIMIT_REACHED
            let safeFileResults = info.fileResults ? info.fileResults.map((f: FileInfo) => ({ filename: f.filename, size: Number(f.size || 0), duration: Number(f.duration || 0) })) : [];
            let statusString = info.status === 4 ? 'FAILED' : info.status === 5 ? 'ABORTED' : 'LIMIT_REACHED';
            this.logger.error(`[CALL-RECORDING] event=EGRESS_FAILED callId=${sessionId} roomName=${roomName} egressId=${egressId} status=${statusString} error="${info.error}" errorCode=${info.errorCode} details="${info.details}" retryCount=${info.errorCount} fileResults=${JSON.stringify(safeFileResults)} manifestLocation=${info.roomName}`);

            await this.prisma.callSession.update({
              where: { id: sessionId },
              data: { recordingStatus: 'FAILED' }
            });
            break;
          }
        }
      } catch (e: any) {
        this.logger.error(`[CALL-RECORDING] processEgress error: ${e.message}`);
      }
      retries++;
    }
  }

  private async uploadLivekitEgressToSupabase(
    egressUrl: string,
    roomName: string,
    sessionId: string,
  ): Promise<{ path: string } | null> {
    try {
      this.logger.log(`Fetching LiveKit recording from: ${egressUrl}`);

      const response = await fetch(egressUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch recording from LiveKit: ${response.statusText}`);
      }

      const buffer = await response.buffer();
      const supabaseUrl = process.env.SUPABASE_URL || 'https://aws-1-ap-southeast-1.pooler.supabase.com';
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy_key';
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(supabaseUrl, supabaseKey);

      const d = new Date();
      const month = (d.getMonth() + 1).toString().padStart(2, '0');
      const date = d.getDate().toString().padStart(2, '0');
      const path = `${d.getFullYear()}/${month}/${date}/${roomName}/recording.mp4`;

      this.logger.log(`[CALL-RECORDING] event=SUPABASE_UPLOAD_START callId=${sessionId} storagePath=${path}`);

      const { data, error } = await supabase.storage
        .from('call-recordings')
        .upload(path, buffer, {
          contentType: 'video/mp4',
          upsert: true,
        });

      if (error) {
        throw error;
      }

      this.logger.log(`[CALL-RECORDING] event=SUPABASE_UPLOAD_COMPLETE callId=${sessionId} storagePath=${data.path} size=${buffer.length}`);
      return { path: data.path };
    } catch (error: any) {
      this.logger.error(`Failed to upload LiveKit recording to Supabase: ${error.message}`);
      return null;
    }
  }
  async dispatchVoiceBot(roomName: string) {
    this.logger.log(`[AI Voicebot Placeholder] Dispatching AI Voicebot to room: ${roomName}`);
  }

  // ==========================================
  // NORMALIZED EVENT PROCESSING (PHASE 7, 9, 10, 11)
  // ==========================================
  async processNormalizedEvent(event: NormalizedCallEvent, req: any): Promise<boolean> {
    const safeCallId = event.providerCallId || Date.now().toString();
    const idempotencyKey = `call_event:${event.provider}:${safeCallId}:${event.eventType}`;

    // Idempotency Lock
    try {
      if (this.redis.status === 'ready') {
        const setLock = await this.redis.setnx(idempotencyKey, '1');
        if (setLock === 0) {
          this.logger.warn(`Duplicate webhook received for ${idempotencyKey}, ignoring.`);
          return true; // Already processed
        }
        // Expire lock after 24 hours
        await this.redis.expire(idempotencyKey, 86400);
      } else {
        this.logger.warn(`Redis not ready, skipping idempotency lock for ${idempotencyKey}`);
      }
    } catch (e) {
      this.logger.warn(`Redis error, skipping idempotency lock for ${idempotencyKey}`);
    }

    this.logger.log(`Processing Normalized Event [${event.eventType}] for Call ${event.providerCallId}`);

    if (event.direction === 'OUTBOUND') {
      this.logger.log(`[CALL-DIRECTION] provider=${event.provider} providerCallId=${event.providerCallId} direction=outbound route=OUTBOUND_LIFECYCLE`);
      return await this.processOutboundProviderEvent(event, req);
    } else {
      this.logger.log(`[CALL-DIRECTION] provider=${event.provider} providerCallId=${event.providerCallId} direction=inbound route=INBOUND_LIFECYCLE`);
    }

    if (event.eventType === 'CALL_RINGING' || event.eventType === 'CALL_INITIATED') {
      this.logger.log(`[INBOUND-TRACE] CALL_INITIATED_RECEIVED | callId=${event.providerCallId} provider=${event.provider}`);
      // Incoming call setup

      this.logger.log(`[INBOUND-TRACE] CALL_SESSION_LOOKUP | callId=${event.providerCallId}`);

      const customerContext = await this.lookupCustomerContext(event.fromNumber);

      let assignedAgent = null;
      for (let i = 0; i < 5; i++) {
        const potentialAgent = await this.queueService.allocateAgent();
        if (!potentialAgent) break; // No agents available at all

        if (potentialAgent.socketId) {
          const directSocket = this.telephonyGateway.server?.sockets?.sockets?.get(potentialAgent.socketId);
          if (directSocket?.connected) {
            assignedAgent = potentialAgent;
            break;
          }
          const sockets = await this.telephonyGateway.server.in(potentialAgent.socketId).fetchSockets();
          if (sockets.length > 0) {
            assignedAgent = potentialAgent;
            break; // Found an active, connected agent
          }
        }

        // Stale socket detected: agent is in DB as AVAILABLE but has no actual WebSocket connection
        this.logger.warn(`Allocated agent ${potentialAgent.name} but socket ${potentialAgent.socketId} is dead. Marking offline.`);
        await this.prisma.agent.update({
          where: { id: potentialAgent.id },
          data: { status: 'OFFLINE', activeCalls: 0, socketId: null }
        });
      }

      if (!assignedAgent) {
        // Fallback: Check if any agent is marked AVAILABLE or logged in
        const fallbackAgent = await this.prisma.agent.findFirst({
          where: { status: 'AVAILABLE', isDeleted: false },
          orderBy: { activeCalls: 'asc' },
        });
        if (fallbackAgent) {
          this.logger.log(`[INBOUND-TRACE] Fallback to available agent: ${fallbackAgent.name} (${fallbackAgent.id})`);
          assignedAgent = fallbackAgent;
        }
      }

      this.logger.log(`[INBOUND-TRACE] AGENT_SELECTION | callId=${event.providerCallId} assignedAgentId=${assignedAgent?.id}`);

      if (!assignedAgent) {
        this.logger.warn(`No agents available for call ${event.providerCallId}`);
        return false;
      }

      this.logger.log(`[INBOUND-TRACE] PROVIDER_SELECTION | callId=${event.providerCallId} provider=${event.provider}`);
      this.logger.log(`[INBOUND-TRACE] MEDIA_ROUTING | callId=${event.providerCallId} routing_to=livekit`);

      let roomName = event.roomName || `call_${event.providerCallId}`;
      let sipParticipantIdentity = null;
      let sipParticipantRoom = null;

      this.logger.log(`[INBOUND-LIVEKIT] callId=${event.providerCallId} backendRoom=${roomName}`);

      if (event.direction === 'INBOUND' || !event.direction) {
        this.logger.log(`[INBOUND-LIVEKIT] Polling LiveKit to find actual SIP participant room for ${event.fromNumber}...`);
        const livekitRoomInfo = await this.livekitService.findInboundSipRoom(event.fromNumber);

        if (livekitRoomInfo) {
          roomName = livekitRoomInfo.roomName;
          sipParticipantIdentity = livekitRoomInfo.participantIdentity;
          sipParticipantRoom = livekitRoomInfo.roomName;
          this.logger.log(`[INBOUND-LIVEKIT] sipParticipantCreated=true sipParticipantIdentity=${sipParticipantIdentity} sipParticipantRoom=${sipParticipantRoom}`);
          this.logger.log(`[INBOUND-LIVEKIT] roomMatch=true`);
        } else {
          this.logger.log(`[INBOUND-LIVEKIT] sipParticipantCreated=false sipParticipantIdentity=null sipParticipantRoom=null`);
          this.logger.log(`[INBOUND-LIVEKIT] roomMatch=false`);
        }
      }

      event.roomName = roomName; // Ensure it's populated

      if (event.direction === 'INBOUND') {
        this.logger.log(`[INBOUND-CALL] session_create_start | caller=${event.fromNumber} DID=${event.toNumber} providerCallUUID=${event.providerCallId}`);
      }

      // Await session creation to ensure persistence before dispatch
      try {
        const session = await this.createCallSession(
          event.providerCallId,
          roomName,
          customerContext?.customer?.id,
          assignedAgent.userId,
          event.direction || 'inbound',
          event.fromNumber
        );

        if (session && sipParticipantIdentity) {
          await this.prisma.callSession.updateMany({
            where: { id: session.id },
            data: { livekitSipParticipantIdentity: sipParticipantIdentity }
          });
        }

        this.logger.log(`[INBOUND-TRACE] CALL_SESSION_CREATED | callId=${session?.id} providerCallId=${event.providerCallId} direction=inbound provider=${event.provider} status=${session?.status}`);
        if (event.direction === 'INBOUND') {
          this.logger.log(`[INBOUND-CALL] session_created | session_id=${session?.id} caller=${event.fromNumber} DID=${event.toNumber} providerCallUUID=${event.providerCallId} direction=inbound status=${session?.status}`);
        }
      } catch (e: any) {
        if (event.direction === 'INBOUND') {
          this.logger.error(`[INBOUND-CALL] session_create_failed | reason=${e.message}`);
        }
        this.logger.error(`Session creation failed: ${e.message}`);
      }

      // Generate Agent LiveKit Token
      const token = await this.livekitService.generateAgentToken(
        roomName,
        assignedAgent.name || 'Agent',
      );
      const livekitWsUrl = process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_API_URL;

      this.logger.log(`[INBOUND-E2E] STEP=BEFORE_GATEWAY_DISPATCH | callId=${event.providerCallId} providerCallId=${event.providerCallId} direction=${event.direction} agentId=${assignedAgent.id} agentName=${assignedAgent.name} roomName=${roomName} tokenPresent=${!!token}`);

      // Dispatch via Gateway
      this.telephonyGateway.dispatchIncomingCallToAgent(
        assignedAgent.socketId,
        {
          caller: event.fromNumber,
          phone: event.fromNumber,
          callSid: event.providerCallId,
          roomName,
          timestamp: Date.now(),
          source: event.provider,
          customerContext,
          assignedAgent: {
            id: assignedAgent.id,
            name: assignedAgent.name,
          },
          token,
          serverUrl: livekitWsUrl,
          wsUrl: livekitWsUrl,
        },
      );

      this.logger.log(`[INBOUND-E2E] STEP=AFTER_GATEWAY_DISPATCH | callId=${event.providerCallId} result=emitted`);

      this.logger.log(`[INBOUND-TRACE] COMPLETE | callId=${event.providerCallId}`);
      return false; // Not fully "processed" if it needs a TwiML response
    }

    if (event.eventType === 'CALL_CONNECTED') {
      let targetCallSid = event.providerCallId;

      this.logger.log(`[CALL-LIFECYCLE] ` + JSON.stringify({
        event: 'provider_call_connected',
        sessionID: targetCallSid,
        CallUUID: event.providerCallId,
        source: event.provider
      }));
      this.telephonyGateway.server.emit('callConnected', { callSid: targetCallSid });
      return true;
    }

    if (['CALL_ENDED', 'CALL_MISSED', 'CALL_FAILED'].includes(event.eventType)) {
      let targetCallSid = event.providerCallId;



      this.logger.log(`[CALL-LIFECYCLE] ` + JSON.stringify({
        event: 'provider_call_ended',
        sessionID: targetCallSid,
        CallUUID: event.providerCallId,
        source: event.provider,
        reason: event.eventType
      }));

      await this.endCallSession(targetCallSid, event.duration, event.recordingUrl, true);
      this.logger.log(`Emitting callEnded for ${targetCallSid} to frontend.`);
      this.telephonyGateway.server.emit('callEnded', { callSid: targetCallSid });
    }

    return true; // Processed
  }

  // ==========================================
  // OUTBOUND CALLING (PHASE 8 & 14)
  // ==========================================
  async initiateOutboundCall(request: OutboundCallRequest) {
    this.logger.log(`Initiating Outbound Call to ${request.to}`);

    // Determine provider
    const providerType = process.env.TELEPHONY_PROVIDER || 'vobiz';

    const roomName = `call_outbound_${Date.now()}`;
    const callSid = roomName; // Using roomName as callSid temporarily for outbound trackability

    // Lookup agent to attach to session
    let agent = await this.prisma.agent.findFirst({
      where: { userId: request.agentId },
    });
    if (!agent) {
      agent = await this.prisma.agent.findUnique({ where: { id: request.agentId } });
    }

    // Create Call Session tracking record in the background
    await this.createCallSession(
      callSid,
      roomName,
      request.contactId, // Associate customer
      agent?.userId,
      'outbound',
      request.to,
      request.leadId,
      request.conversationId,
    );

    let providerResponse;
    if (providerType === 'vobiz') {
      const { VobizProvider } = require('./providers/vobiz.provider');
      const vobizProvider = new VobizProvider(this.livekitService);
      providerResponse = await vobizProvider.initiateOutboundCall(request, roomName);

      // Persist the SIP participant identity
      if (providerResponse.sipParticipantIdentity) {
        await this.prisma.callSession.updateMany({
          where: { reason: callSid },
          data: { livekitSipParticipantIdentity: providerResponse.sipParticipantIdentity }
        });
      }
    } else {
      const { ExotelProvider } = require('./providers/exotel.provider');
      const exotelProvider = new ExotelProvider();
      providerResponse = await exotelProvider.initiateOutboundCall(request, roomName);
    }

    // Generate token for agent
    const token = await this.livekitService.generateAgentToken(
      roomName,
      agent?.name || 'Agent',
    );

    // Auto-poll to start recording in background when participants connect
    setTimeout(() => {
      this.startLivekitRecording(callSid, roomName).catch(err => {
        this.logger.warn(`[CALL-RECORDING] Auto-start recording background error: ${err.message}`);
      });
    }, 2000);

    const livekitWsUrl = process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_API_URL;
    return {
      success: true,
      roomName,
      token,
      serverUrl: livekitWsUrl,
      wsUrl: livekitWsUrl,
      provider: providerType,
      providerResponse
    };
  }

  public async triggerPostCallPipeline(session: any, recordingUrl: string | null = null) {
    this.logger.log(`Starting post-call AI pipeline for session ${session.id}`);

    // Trigger real AI summary using the Call Session ID
    try {
      await this.analyticsService.generateCallSummary(session.id);
    } catch (error) {
      this.logger.error(`[AI-AUDIT] event=PIPELINE_FAILED callId=${session.id} error="${error.message || error}"`);
    }
  }

  // =========================================================================
  // PHASE 14 — OMNICHANNEL MESSAGING FROM CALL LOGS & CUSTOMER INTELLIGENCE
  // =========================================================================

  async sendMessageFromCall(
    callId: string,
    body: {
      channel: 'WHATSAPP' | 'EMAIL' | 'INSTAGRAM' | string;
      recipient: string;
      message: string;
      subject?: string;
      leadId?: string;
    },
    user?: any,
  ) {
    if (!body.message || !body.message.trim()) {
      throw new BadRequestException('Message content cannot be empty');
    }
    if (!body.recipient || !body.recipient.trim()) {
      throw new BadRequestException('Recipient destination identifier is required');
    }

    const channelUpper = (body.channel || 'WHATSAPP').toUpperCase();

    // Find callSession
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isUuid = UUID_REGEX.test(callId);
    const session = isUuid
      ? await this.prisma.callSession.findUnique({
          where: { id: callId },
          include: { lead: true, customer: true, conversation: true }
        })
      : await this.prisma.callSession.findFirst({
          where: { reason: callId },
          include: { lead: true, customer: true, conversation: true }
        });

    let lead = session?.lead;
    if (!lead && body.leadId && UUID_REGEX.test(body.leadId)) {
      lead = await this.prisma.lead.findUnique({ where: { id: body.leadId } });
    }

    // Resolve or create Customer
    let customer = session?.customer;
    if (!customer) {
      if (channelUpper === 'WHATSAPP' || channelUpper === 'VOICE') {
        customer = await this.prisma.customer.findFirst({
          where: { phone: body.recipient.trim() }
        });
      } else if (channelUpper === 'EMAIL') {
        customer = await this.prisma.customer.findFirst({
          where: { email: { equals: body.recipient.trim(), mode: 'insensitive' } }
        });
      }
    }

    if (!customer) {
      customer = await this.prisma.customer.create({
        data: {
          name: lead?.customerName || (channelUpper === 'EMAIL' ? body.recipient.split('@')[0] : `Customer ${body.recipient}`),
          phone: channelUpper === 'WHATSAPP' ? body.recipient.trim() : (lead?.phoneNumber || `+91${Date.now().toString().slice(-10)}`),
          email: channelUpper === 'EMAIL' ? body.recipient.trim() : (lead?.email || null),
        }
      });
    }

    // Resolve or create Conversation
    let conversation = session?.conversation;
    if (!conversation) {
      conversation = await this.prisma.conversation.findFirst({
        where: {
          customerId: customer.id,
          channel: (channelUpper === 'WHATSAPP' ? 'WHATSAPP' : (channelUpper === 'INSTAGRAM' ? 'INSTAGRAM' : 'EMAIL')) as any
        },
        orderBy: { updatedAt: 'desc' }
      });
    }

    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          customerId: customer.id,
          channel: (channelUpper === 'WHATSAPP' ? 'WHATSAPP' : (channelUpper === 'INSTAGRAM' ? 'INSTAGRAM' : 'EMAIL')) as any,
          leadId: lead?.id || null,
          foundation: lead?.foundation || 'Elder Care',
          primaryService: lead?.primaryService || 'General Care',
          status: 'OPEN',
          priority: (lead?.priority as any) || 'NORMAL',
          agentId: user?.agentId || user?.id || null,
        }
      });
    }

    const providerMessageId = `msg_${channelUpper.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Create Message in Conversation
    const messageRecord = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        content: body.message.trim(),
        senderType: 'AGENT',
        status: 'SENT',
        isAiSuggested: false,
      }
    });

    // Create LeadActivity entry if lead exists
    let leadActivity: any = null;
    if (lead) {
      leadActivity = await this.prisma.leadActivity.create({
        data: {
          leadId: lead.id,
          callSessionId: session?.id || null,
          conversationId: conversation.id,
          agentId: user?.agentId || null,
          type: 'COMMUNICATION',
          channel: channelUpper,
          direction: 'OUTBOUND',
          title: `Outbound ${channelUpper} to ${body.recipient}`,
          content: body.message.trim(),
          providerMessageId,
          status: 'SENT',
          metadata: {
            subject: body.subject || null,
            senderUserId: user?.id || user?.userId || null,
            senderEmail: user?.email || null,
            deliveredAt: new Date().toISOString(),
          }
        }
      });
    }

    // Touch Conversation
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        updatedAt: new Date(),
        leadId: lead?.id || conversation.leadId,
      }
    });

    // Broadcast WebSocket event
    try {
      this.telephonyGateway.server.emit('omnichannelMessageSent', {
        conversationId: conversation.id,
        messageId: messageRecord.id,
        channel: channelUpper,
        recipient: body.recipient,
        content: body.message,
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}

    return {
      success: true,
      messageId: messageRecord.id,
      providerMessageId,
      channel: channelUpper,
      recipient: body.recipient,
      status: 'SENT',
      deliveryStatus: 'ACCEPTED_BY_PROVIDER',
      conversationId: conversation.id,
      leadActivityId: leadActivity?.id || null,
      timestamp: messageRecord.createdAt.toISOString(),
    };
  }

  async getCustomerHistoryIntelligence(phoneOrLeadId: string, user?: any) {
    if (!phoneOrLeadId || typeof phoneOrLeadId !== 'string') {
      throw new BadRequestException('Identifier (phone number, customer ID, or lead ID) is required');
    }

    try {
      // 1. Normalize and decode input exactly once
      let decoded = phoneOrLeadId.trim();
      try {
        decoded = decodeURIComponent(decoded);
      } catch (_) {}
      decoded = decoded.trim();

      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const isUuid = UUID_REGEX.test(decoded);
      const isEmail = decoded.includes('@');

      // Canonical phone normalization
      let cleanPhone = decoded.replace(/[^\d+]/g, '');
      if (cleanPhone.startsWith('00')) {
        cleanPhone = '+' + cleanPhone.substring(2);
      } else if (cleanPhone.startsWith('0') && cleanPhone.length === 11) {
        cleanPhone = '+91' + cleanPhone.substring(1);
      } else if (!cleanPhone.startsWith('+') && cleanPhone.length === 10) {
        cleanPhone = `+91${cleanPhone}`;
      } else if (!cleanPhone.startsWith('+') && cleanPhone.startsWith('91') && cleanPhone.length === 12) {
        cleanPhone = `+${cleanPhone}`;
      }

      // Generate phone variants for lookup (E.164, national 10-digit, prefixed)
      const nationalNumber = cleanPhone.replace(/^\+91/, '').replace(/^\+/, '');
      const phoneVariants = [
        cleanPhone,
        nationalNumber,
        `+91${nationalNumber}`,
        `91${nationalNumber}`,
        `0${nationalNumber}`,
      ].filter((p) => p && p.length >= 7);
      const uniqueVariants = Array.from(new Set(phoneVariants));

      // Find matches in Lead and Customer
      let lead: any = null;
      let customer: any = null;

      if (isUuid) {
        lead = await this.prisma.lead.findUnique({
          where: { id: decoded },
          include: { unit: true, assignedAgent: true }
        });
        if (!lead) {
          customer = await this.prisma.customer.findUnique({
            where: { id: decoded }
          });
        }
      } else if (isEmail) {
        lead = await this.prisma.lead.findFirst({
          where: { email: { equals: decoded, mode: 'insensitive' } },
          include: { unit: true, assignedAgent: true },
          orderBy: { updatedAt: 'desc' }
        });
        if (!customer) {
          customer = await this.prisma.customer.findFirst({
            where: { email: { equals: decoded, mode: 'insensitive' } }
          });
        }
      }

      if (!lead && uniqueVariants.length > 0) {
        lead = await this.prisma.lead.findFirst({
          where: {
            OR: uniqueVariants.map((p) => ({ phoneNumber: p }))
          },
          include: { unit: true, assignedAgent: true },
          orderBy: { updatedAt: 'desc' }
        });
      }

      if (!customer && (uniqueVariants.length > 0 || lead?.phoneNumber)) {
        const variantsToSearch = lead?.phoneNumber
          ? Array.from(new Set([...uniqueVariants, lead.phoneNumber, lead.phoneNumber.replace('+91', '')]))
          : uniqueVariants;

        customer = await this.prisma.customer.findFirst({
          where: {
            OR: variantsToSearch.map((p) => ({ phone: p }))
          }
        });
      }

      const matchedPhone = cleanPhone || lead?.phoneNumber || customer?.phone || (nationalNumber ? `+91${nationalNumber}` : decoded);
      const leadIds: string[] = lead ? [lead.id] : [];
      const customerIds: string[] = customer ? [customer.id] : [];

      // Build call session lookup conditions safely
      const callSessionConditions: any[] = [];
      if (leadIds.length > 0) {
        callSessionConditions.push({ leadId: { in: leadIds } });
      }
      if (customerIds.length > 0) {
        callSessionConditions.push({ customerId: { in: customerIds } });
      }
      if (nationalNumber && nationalNumber.length >= 7) {
        callSessionConditions.push(
          { customer: { phone: { contains: nationalNumber } } },
          { lead: { phoneNumber: { contains: nationalNumber } } },
          { reason: { contains: nationalNumber } }
        );
      }

      // Query cross-unit call sessions (without invalid Prisma relation includes)
      const callSessions = callSessionConditions.length > 0
        ? await this.prisma.callSession.findMany({
            where: { OR: callSessionConditions },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: {
              participants: true,
              caller: { select: { agentProfile: { select: { name: true, department: true } } } },
              callee: { select: { agentProfile: { select: { name: true, department: true } } } },
              lead: { select: { customerName: true, unit: { select: { name: true, code: true } } } },
              transferAudits: {
                orderBy: { createdAt: 'desc' },
                include: {
                  initiatingAgent: { select: { id: true, name: true, department: true } },
                  destinationAgent: { select: { id: true, name: true, department: true } },
                }
              },
              analytics: true,
            }
          })
        : [];

      // Query all cross-unit conversations
      const convConditions: any[] = [];
      if (leadIds.length > 0) convConditions.push({ leadId: { in: leadIds } });
      if (customerIds.length > 0) convConditions.push({ customerId: { in: customerIds } });

      const conversations = convConditions.length > 0
        ? await this.prisma.conversation.findMany({
            where: { OR: convConditions },
            orderBy: { updatedAt: 'desc' },
            take: 20,
            include: {
              messages: { orderBy: { createdAt: 'desc' }, take: 3 }
            }
          })
        : [];

      // Query all lead activities
      const activities = leadIds.length > 0
        ? await this.prisma.leadActivity.findMany({
            where: { leadId: { in: leadIds } },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: { agent: { select: { name: true, department: true } } }
          })
        : [];

      // Query all followups
      const followups = leadIds.length > 0
        ? await this.prisma.leadFollowup.findMany({
            where: { leadId: { in: leadIds } },
            orderBy: { followupDate: 'desc' },
            take: 20,
            include: { assignedAgent: { select: { name: true, department: true } } }
          })
        : [];

      // Query all lead transfer audits
      const transferAudits = leadIds.length > 0
        ? await this.prisma.leadTransferAudit.findMany({
            where: { leadId: { in: leadIds } },
            orderBy: { createdAt: 'desc' },
            include: {
              sourceUnit: true,
              destUnit: true,
              transferredBy: { select: { email: true } },
              assignedAgent: { select: { name: true } },
            }
          })
        : [];

      // Identify unique Business Units Contacted across history
      const unitsContactedSet = new Set<string>();
      if (lead?.unit?.name) unitsContactedSet.add(lead.unit.name);
      if (lead?.foundation) unitsContactedSet.add(lead.foundation);
      transferAudits.forEach((t) => {
        if (t.sourceUnit?.name) unitsContactedSet.add(t.sourceUnit.name);
        if (t.destUnit?.name) unitsContactedSet.add(t.destUnit.name);
      });
      callSessions.forEach((c) => {
        if (c.lead?.unit?.name) unitsContactedSet.add(c.lead.unit.name);
        if ((c.caller?.agentProfile as any)?.department) unitsContactedSet.add((c.caller?.agentProfile as any).department);
        c.transferAudits?.forEach((cta: any) => {
          if (cta.sourceDepartment) unitsContactedSet.add(cta.sourceDepartment);
          if (cta.destDepartment) unitsContactedSet.add(cta.destDepartment);
        });
      });
      conversations.forEach((c) => {
        if (c.foundation) unitsContactedSet.add(c.foundation);
      });

    // Identify unique Services Requested across history
    const servicesRequestedSet = new Set<string>();
    if (lead?.primaryService) servicesRequestedSet.add(lead.primaryService);
    if (lead?.serviceInterest) servicesRequestedSet.add(lead.serviceInterest);
    if (lead?.subServices && Array.isArray(lead.subServices)) {
      lead.subServices.forEach((s: string) => servicesRequestedSet.add(s));
    }
    conversations.forEach(c => {
      if (c.primaryService) servicesRequestedSet.add(c.primaryService);
    });

    // Check emergency state
    const isEmergency = Boolean(
      lead?.isAmbulanceEmergency ||
      callSessions.some(c => (c.intakeForm as any)?.isEmergency || c.lead?.customerName?.toLowerCase().includes('emergency'))
    );

    // Build unified chronological timeline
    const timeline: any[] = [];

    callSessions.forEach(c => {
      const isOutbound = c.reason?.startsWith('call_outbound_') || (c.transferHistory as any)?.direction === 'outbound';
      timeline.push({
        id: c.id,
        type: 'CALL',
        title: `${isOutbound ? 'Outbound' : 'Inbound'} Call (${c.status})`,
        timestamp: c.startedAt || c.createdAt,
        channel: 'VOICE',
        direction: isOutbound ? 'OUTBOUND' : 'INBOUND',
        agent: c.caller?.agentProfile?.name || c.callee?.agentProfile?.name || 'Agent',
        department: c.caller?.agentProfile?.department || c.callee?.agentProfile?.department || 'Contact Center',
        unit: c.lead?.unit?.name || 'General',
        duration: c.duration || 0,
        recordingAvailable: c.recordingStatus === 'READY',
        recordingUrl: c.recordingUrl,
        summary: c.analytics?.summary || (c.liveNotes as any)?.notes || null,
        service: (c.intakeForm as any)?.primaryService || null,
      });
    });

    conversations.forEach(c => {
      timeline.push({
        id: c.id,
        type: 'CONVERSATION',
        title: `Omnichannel Conversation (${c.channel})`,
        timestamp: c.updatedAt || c.createdAt,
        channel: c.channel,
        direction: 'INBOUND',
        unit: c.foundation || 'Elder Care',
        service: c.primaryService || null,
        lastMessage: c.messages?.[0]?.content || null,
      });
    });

    activities.forEach(a => {
      timeline.push({
        id: a.id,
        type: a.type,
        title: a.title,
        timestamp: a.createdAt,
        channel: a.channel,
        direction: a.direction,
        agent: a.agent?.name || 'System',
        content: a.content,
        status: a.status,
      });
    });

    transferAudits.forEach(t => {
      timeline.push({
        id: t.id,
        type: 'TRANSFER',
        title: `Transferred to ${t.destUnit?.name || 'New Unit'}`,
        timestamp: t.createdAt,
        channel: 'SYSTEM',
        sourceUnit: t.sourceUnit?.name || 'Previous Unit',
        destUnit: t.destUnit?.name || 'Destination Unit',
        reason: t.reason,
        transferredBy: t.transferredBy?.email || 'Super Admin',
      });
    });

    followups.forEach(f => {
      timeline.push({
        id: f.id,
        type: 'FOLLOWUP',
        title: `Follow-up / Callback (${f.status})`,
        timestamp: f.followupDate,
        agent: f.assignedAgent?.name || 'Assigned Agent',
        purpose: f.purpose,
        notes: f.notes,
        status: f.status,
      });
    });

    timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      return {
        resolvedCustomer: {
          id: customer?.id || null,
          leadId: lead?.id || null,
          name: lead?.customerName || customer?.name || 'Unknown Contact',
          phone: matchedPhone || 'No Phone',
          email: lead?.email || customer?.email || null,
          currentUnit: lead?.unit?.name || 'Unassigned',
          currentUnitId: lead?.unit?.id || null,
          currentAgent: lead?.assignedAgent?.name || 'Unassigned',
          currentStatus: lead?.status || 'NEW',
          priority: isEmergency ? 'EMERGENCY' : (lead?.priority || 'NORMAL'),
          notes: lead?.notes || null,
        },
        businessUnitsContacted: Array.from(unitsContactedSet),
        requestedServices: Array.from(servicesRequestedSet),
        timeline,
        isEmergency,
        stats: {
          totalCalls: callSessions.length,
          totalRecordings: callSessions.filter(c => c.recordingStatus === 'READY').length,
          totalConversations: conversations.length,
          totalFollowups: followups.length,
          totalTransfers: transferAudits.length,
        }
      };
    } catch (err: any) {
      this.logger.error(`[CUSTOMER-HISTORY] Error resolving history for identifier="${phoneOrLeadId}": ${err.message}`, err.stack);
      if (err instanceof BadRequestException) throw err;
      return {
        resolvedCustomer: {
          id: null,
          leadId: null,
          name: 'Unknown Contact',
          phone: phoneOrLeadId,
          email: null,
          currentUnit: 'Unassigned',
          currentUnitId: null,
          currentAgent: 'Unassigned',
          currentStatus: 'NEW',
          priority: 'NORMAL',
          notes: null,
        },
        businessUnitsContacted: [],
        requestedServices: [],
        timeline: [],
        isEmergency: false,
        stats: {
          totalCalls: 0,
          totalRecordings: 0,
          totalConversations: 0,
          totalFollowups: 0,
          totalTransfers: 0,
        }
      };
    }
  }

  async previewCrossUnitLeadTransfer(leadId: string, destUnitId: string, user?: any) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        unit: true,
        assignedAgent: true,
        followups: true,
        callSessions: true,
        transferAudits: true,
      }
    });
    if (!lead) throw new NotFoundException('Lead not found');

    const destUnit = await this.prisma.businessUnit.findUnique({
      where: { id: destUnitId }
    });
    if (!destUnit) throw new NotFoundException('Destination business unit not found');

    // Available agents in destination unit
    const agentsInDest = await this.prisma.agent.findMany({
      where: {
        isDeleted: false,
        OR: [
          { department: { contains: destUnit.name, mode: 'insensitive' } },
          { departments: { some: { name: { contains: destUnit.name, mode: 'insensitive' } } } }
        ]
      },
      select: { id: true, name: true, department: true, status: true }
    });

    return {
      lead: {
        id: lead.id,
        name: lead.customerName,
        phone: lead.phoneNumber,
        email: lead.email,
        priority: lead.priority,
        currentUnit: lead.unit ? { id: lead.unit.id, name: lead.unit.name, code: lead.unit.code } : null,
        currentAgent: lead.assignedAgent ? { id: lead.assignedAgent.id, name: lead.assignedAgent.name } : null,
        primaryService: lead.primaryService || 'General Care',
      },
      destinationUnit: {
        id: destUnit.id,
        name: destUnit.name,
        code: destUnit.code,
      },
      eligibleAgents: agentsInDest,
      historicalSummary: {
        totalCalls: lead.callSessions?.length || 0,
        totalFollowups: lead.followups?.length || 0,
        previousTransfers: lead.transferAudits?.length || 0,
        policyNote: 'All historical call sessions, recordings, notes, follow-ups, and omnichannel threads are retained permanently.',
      }
    };
  }

  async executeCrossUnitLeadTransfer(
    leadId: string,
    body: {
      destUnitId: string;
      destDepartment?: string;
      assignedAgentId?: string;
      reason: string;
    },
    user?: any,
  ) {
    if (!body.destUnitId) throw new BadRequestException('Destination business unit ID is required');
    if (!body.reason || !body.reason.trim()) throw new BadRequestException('Transfer reason is required');

    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      include: { unit: true }
    });
    if (!lead) throw new NotFoundException('Lead not found');

    const destUnit = await this.prisma.businessUnit.findUnique({
      where: { id: body.destUnitId }
    });
    if (!destUnit) throw new NotFoundException('Destination unit not found');

    const actorUserId = user?.id || user?.userId || user?.sub || null;

    return await this.prisma.$transaction(async (tx) => {
      const updatedLead = await tx.lead.update({
        where: { id: leadId },
        data: {
          unitId: destUnit.id,
          assignedAgentId: body.assignedAgentId || null,
        }
      });

      const audit = await tx.leadTransferAudit.create({
        data: {
          leadId,
          sourceUnitId: lead.unitId || null,
          destUnitId: destUnit.id,
          assignedAgentId: body.assignedAgentId || null,
          transferredById: actorUserId,
          status: 'COMPLETED',
          sourceDepartment: lead.unit?.name || 'General',
          destDepartment: body.destDepartment || destUnit.name,
          reason: body.reason.trim(),
          preserveHistory: true,
          metadata: {
            actorEmail: user?.email || 'Authorized User',
            timestamp: new Date().toISOString(),
          }
        }
      });

      await tx.leadActivity.create({
        data: {
          leadId,
          agentId: body.assignedAgentId || null,
          type: 'TRANSFER',
          channel: 'SYSTEM',
          direction: 'OUTBOUND',
          title: `Cross-Unit Lead Transfer to ${destUnit.name}`,
          content: `Transferred from ${lead.unit?.name || 'Unassigned'} to ${destUnit.name}. Reason: ${body.reason.trim()}`,
          status: 'COMPLETED',
          metadata: {
            auditId: audit.id,
            sourceUnit: lead.unit?.name || 'Unassigned',
            destUnit: destUnit.name,
          }
        }
      });

      return {
        success: true,
        leadId: updatedLead.id,
        leadName: updatedLead.customerName,
        sourceUnit: lead.unit?.name || 'Unassigned',
        destinationUnit: destUnit.name,
        assignedAgentId: body.assignedAgentId || null,
        transferredAt: audit.createdAt.toISOString(),
      };
    });
  }
}








