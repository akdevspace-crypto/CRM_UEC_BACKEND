import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
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
  ) {
    this.logger.log(`Creating CallSession for ${callSid} in room ${roomName}`);
    try {
      return await this.prisma.callSession.create({
        data: {
          reason: callSid, // Store Vobiz CallSid here since it's not a valid UUID
          customerId,
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

  async getCallHistory(user?: any) {
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user.role);
    const whereClause: any = { status: { in: ['ENDED', 'MISSED', 'REJECTED'] } };

    if (!isElevated && user) {
      whereClause.OR = [
        { callerUserId: user.userId },
        { calleeUserId: user.userId },
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
    }

    const records = await this.prisma.callSession.findMany({
      where: whereClause,
      orderBy: { startedAt: 'desc' },
      take: 50,
      include: {
        customer: { select: { name: true, phone: true } },
        conversation: { select: { aiSummary: true } }
      },
    });

    const jwt = require('jsonwebtoken');
    const jwtSecret = process.env.JWT_SECRET || 'crm-secure-jwt-secret-key-2026';
    const baseUrl = process.env.BASE_URL || 'https://crm-uec-backend.onrender.com';

    return records.map(r => {
      // Find summary if conversation has one attached
      const summaryObj = r.conversation?.aiSummary;
      const aiSummary = summaryObj ? Array.isArray(summaryObj) ? summaryObj[0] : summaryObj : null;

      let tokenQuery = '';
      if (user && (user.userId || user.id || user.sub)) {
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

      return {
        id: r.id,
        callSid: r.reason,
        customerName: r.customer?.name || r.customer?.phone || 'Unknown',
        duration: r.duration || 0,
        direction: r.reason?.startsWith('call_outbound_') ? 'OUTBOUND' : 'INBOUND',
        timestamp: r.startedAt ? r.startedAt.toISOString() : r.createdAt.toISOString(),
        recordingUrl: r.recordingStatus === 'READY' ? `${baseUrl}/telephony/calls/${r.id}/recording${tokenQuery}` : (r.recordingUrl || null),
        recordingStatus: r.recordingStatus || 'NOT_AVAILABLE',
        aiProcessingStatus: r.aiProcessingStatus || 'PENDING',
        status: r.status,
        summary: aiSummary?.summary || null,
        sentiment: aiSummary?.sentiment || null,
      };
    });
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
          data: { status: 'OFFLINE', activeCalls: { decrement: 1 }, socketId: null }
        });
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
      request.contactId || request.leadId, // Associate customer
      agent?.userId,
      'outbound',
      request.to
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
}








