import { Injectable, Logger, Inject, forwardRef, NotFoundException, ForbiddenException, BadRequestException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import Redis from 'ioredis';
import { QueueService } from '../queue-orchestration/queue.service';
import { TelephonyGateway } from './telephony.gateway';
import { LivekitService } from './livekit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { CapacityService } from './capacity/capacity.service';
import { NormalizedCallEvent, OutboundCallRequest } from './providers/telephony-provider.interface';
import type { FileInfo } from '@livekit/protocol';

@Injectable()
export class TelephonyService {
  private readonly logger = new Logger(TelephonyService.name);
  private readonly terminatingSessions = new Set<string>();
  private readonly recordingAttemptedRooms = new Set<string>();

  public isSessionTerminatedOrTerminating(sessionIdOrReason: string): boolean {
    return this.terminatingSessions.has(sessionIdOrReason);
  }

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    @Inject(forwardRef(() => QueueService)) private readonly queueService: QueueService,
    @Inject(forwardRef(() => TelephonyGateway)) private readonly telephonyGateway: TelephonyGateway,
    @Inject(forwardRef(() => LivekitService)) private readonly livekitService: LivekitService,
    private readonly analyticsService: AnalyticsService,
    @Optional() private readonly capacityService?: CapacityService,
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
        lead: lead || null,
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
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const isUuid = UUID_REGEX.test(callSid);
      const session = await this.prisma.callSession.findFirst({
        where: isUuid
          ? { OR: [{ id: callSid }, { reason: callSid }, { livekitRoom: callSid }] }
          : { OR: [{ reason: callSid }, { livekitRoom: callSid }] },
        include: { transferAudits: { orderBy: { createdAt: 'desc' }, take: 1 } },
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

      const latestAudit = session.transferAudits?.[0];
      const isTransferAcceptance = latestAudit && (latestAudit.status === 'INITIATED' || latestAudit.status === 'CONSULTING');

      if (isTransferAcceptance) {
        await this.prisma.callTransferAudit.update({
          where: { id: latestAudit.id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            destinationAgentId: realAgentId,
          }
        }).catch(() => {});

        const th = (session.transferHistory && typeof session.transferHistory === 'object') ? (session.transferHistory as any) : {};
        if (Array.isArray(th.transfers) && th.transfers.length > 0) {
          th.transfers[th.transfers.length - 1].status = 'COMPLETED';
          th.transfers[th.transfers.length - 1].completedAt = new Date().toISOString();
        }

        await this.prisma.callSession.update({
          where: { id: session.id },
          data: {
            status: 'TRANSFERRED',
            transferHistory: th,
            calleeUserId: agent?.userId || session.calleeUserId,
          },
        });

        this.telephonyGateway.server.emit('callTransferCompleted', {
          callSessionId: session.id,
          callSid: session.reason || session.id,
          transferAuditId: latestAudit.id,
        });
      } else {
        await this.prisma.callSession.update({
          where: { id: session.id },
          data: {
            status: 'IN_PROGRESS',
          },
        });
      }

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

  async getMyActiveCall(agentIdOrUserId: string) {
    try {
      let agent = await this.prisma.agent.findFirst({
        where: { OR: [{ id: agentIdOrUserId }, { userId: agentIdOrUserId }] },
      });
      const candidateUserIds = [agentIdOrUserId];
      if (agent?.userId) candidateUserIds.push(agent.userId);
      const candidateAgentIds = [agentIdOrUserId];
      if (agent?.id) candidateAgentIds.push(agent.id);

      const activeSession = await this.prisma.callSession.findFirst({
        where: {
          status: { in: ['RINGING', 'IN_PROGRESS'] },
          OR: [
            { calleeUserId: { in: candidateUserIds } },
            { callerUserId: { in: candidateUserIds } },
            { participants: { some: { agentId: { in: candidateAgentIds } } } }
          ]
        },
        include: {
          customer: true,
          lead: true,
        },
        orderBy: { createdAt: 'desc' }
      });

      if (!activeSession) {
        return { activeCall: null };
      }

      return {
        activeCall: {
          callSid: activeSession.reason || activeSession.id,
          roomName: activeSession.livekitRoom,
          sessionId: activeSession.id,
          status: activeSession.status,
          customerName: activeSession.customer?.name || activeSession.lead?.customerName || 'Customer',
          phone: activeSession.customer?.phone || activeSession.lead?.phoneNumber || 'Customer Phone',
          startedAt: activeSession.startedAt?.getTime() || activeSession.createdAt.getTime(),
          direction: (activeSession.transferHistory as any)?.direction || (activeSession.reason?.startsWith('call_outbound_') ? 'OUTBOUND' : 'INBOUND'),
        }
      };
    } catch (err: any) {
      this.logger.error(`Error resolving active call for ${agentIdOrUserId}: ${err.message}`);
      return { activeCall: null };
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

    if (event.eventType === 'CALL_CONNECTED') {
      const isTerminal = ['ENDED', 'MISSED', 'CANCELLED', 'UNANSWERED', 'BUSY', 'FAILED', 'REJECTED'].includes(session.status);
      if (isTerminal || this.isSessionTerminatedOrTerminating(session.id) || (session.reason && this.isSessionTerminatedOrTerminating(session.reason))) {
        this.logger.warn(`[CALL-LIFECYCLE] processOutboundProviderEvent: Ignored late CALL_CONNECTED for already terminated session ${session.id} (status=${session.status})`);
        return true;
      }

      this.logger.log(`[CALL-LIFECYCLE-DIAG] callId=${session.reason} stage=CUSTOMER_ANSWERED source=vobiz_outbound_webhook timestamp=${new Date().toISOString()}`);
      await this.prisma.callSession.update({
        where: { id: session.id },
        data: {
          status: 'IN_PROGRESS',
          startedAt: session.startedAt || new Date(),
        }
      });

      // Start recording on answer if not already started
      if (session.livekitRoom && session.recordingStatus !== 'RECORDING') {
        this.startLivekitRecording(session.reason!, session.livekitRoom).catch(err => {
          this.logger.warn(`[CALL-RECORDING] Outbound answer recording error: ${err.message}`);
        });
      }

      this.telephonyGateway.server.emit('callConnected', {
        callSid: session.reason,
        roomName: session.livekitRoom,
        sessionId: session.id,
        answeredAt: new Date().toISOString(),
      });
      return true;
    }

    if (event.eventType === 'CALL_ENDED' || event.eventType === 'CALL_MISSED' || event.eventType === 'CALL_FAILED') {
      const durationStr = raw.Duration || '0';
      const billsecStr = raw.Billsec || '0';
      const duration = parseInt(durationStr, 10);
      const billsec = parseInt(billsecStr, 10);

      this.logger.log(`[OUTBOUND-LIFECYCLE] Call ended. billsec=${billsec}, duration=${duration}, cause=${raw.HangupCause}`);
      await this.endCallSession(session.reason!, billsec > 0 ? billsec : duration, null, true, raw.HangupCause || event.eventType);
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
    if (!roomName && !callSid) return;
    const lookupKey = roomName || callSid;

    if (this.recordingAttemptedRooms.has(lookupKey) || (callSid && this.recordingAttemptedRooms.has(callSid))) {
      this.logger.log(`[CALL-RECORDING] Recording start already attempted for roomName=${roomName} callSid=${callSid}. Skipping duplicate attempt.`);
      return;
    }
    this.recordingAttemptedRooms.add(lookupKey);
    if (callSid) this.recordingAttemptedRooms.add(callSid);

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
      if (!callSession) {
        this.logger.log(`[CALL-RECORDING] Ignored START: session not found callSid=${callSid} roomName=${roomName}`);
        return;
      }

      const isTerminal = ['ENDED', 'MISSED', 'CANCELLED', 'UNANSWERED', 'BUSY', 'FAILED', 'REJECTED'].includes(callSession.status);
      if (isTerminal ||
        callSession.recordingStatus === 'RECORDING' ||
        callSession.recordingStatus === 'PROCESSING' ||
        callSession.recordingStatus === 'READY' ||
        callSession.recordingStatus === 'NOT_AVAILABLE' ||
        callSession.recordingStatus === 'FAILED' ||
        callSession.livekitEgressId) {
        this.logger.log(`[CALL-RECORDING] Ignored START: status=${callSession.status} recordingStatus=${callSession.recordingStatus} egressId=${callSession.livekitEgressId} callSid=${callSid}`);
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
          if (!current || ['ENDED', 'MISSED', 'CANCELLED', 'UNANSWERED', 'BUSY', 'FAILED', 'REJECTED'].includes(current.status)) {
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
      this.logger.log(`[CALL-LIFECYCLE-DIAG] callId=${callSession?.reason || callSid} stage=RECORDING_STARTED source=startLivekitRecording timestamp=${new Date().toISOString()} egressId=${egressId}`);
    } catch (e: any) {
      const errMsg = e.message || String(e);
      const isQuotaExceeded = /egress minutes exceeded|quota|limit exceeded/i.test(errMsg);

      if (isQuotaExceeded) {
        this.logger.warn(`[CALL-RECORDING] LiveKit egress recording quota exhausted for room=${roomName} callSid=${callSid}: ${errMsg}. Call preserved with recordingStatus='NOT_AVAILABLE'.`);
        if (callSession?.id) {
          await this.prisma.callSession.update({
            where: { id: callSession.id },
            data: {
              recordingStatus: 'NOT_AVAILABLE',
              aiProcessingStatus: 'COMPLETED'
            }
          }).catch(() => {});
        }
      } else {
        this.logger.error(`[CALL-RECORDING] START failed for room=${roomName} callSid=${callSid}: ${errMsg}`);
        if (callSession?.id) {
          await this.prisma.callSession.update({
            where: { id: callSession.id },
            data: {
              recordingStatus: 'FAILED',
              aiProcessingStatus: 'COMPLETED'
            }
          }).catch(() => {});
        }
      }
    }
  }

  async endCallSession(
    callSid: string,
    duration: number = 0,
    vobizRecordingUrl: string | null = null,
    forceCleanup: boolean = false,
    reason?: string,
  ) {
    this.logger.log(`Ending CallSession ${callSid} forceCleanup=${forceCleanup} reason=${reason}`);

    const nonDestructiveDisconnectReasons = [
      'webrtc_disconnected',
      'room_disconnected',
      'client_disconnected',
      'network_disconnected'
    ];

    // REQUIREMENT 3 & 4: Do not terminate the PSTN/SIP call solely because the frontend WebRTC or LiveKit room temporarily disconnects!
    if (reason && nonDestructiveDisconnectReasons.includes(reason)) {
      this.logger.warn(`[CALL-LIFECYCLE] Rejecting call termination for callSid=${callSid} with reason='${reason}'. PSTN/SIP call preserved.`);
      return;
    }

    if (this.terminatingSessions.has(callSid)) {
      this.logger.log(`[CALL-LIFECYCLE] Session ${callSid} termination already in progress. Skipping duplicate.`);
      return;
    }

    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callSid);
      const session = await this.prisma.callSession.findFirst({
        where: isUuid
          ? { OR: [{ id: callSid }, { reason: callSid }, { livekitRoom: callSid }] }
          : { OR: [{ reason: callSid }, { livekitRoom: callSid }] },
        include: { participants: true },
      });
      if (!session) return;

      const isTerminal = ['ENDED', 'MISSED', 'CANCELLED', 'UNANSWERED', 'BUSY', 'FAILED', 'REJECTED'].includes(session.status);
      if (isTerminal) {
        this.logger.log(`[CALL-LIFECYCLE] Session ${callSid} is already ${session.status}. Skipping duplicate endCallSession.`);
        return;
      }

      if (this.terminatingSessions.has(session.id) || 
          (session.reason && this.terminatingSessions.has(session.reason)) || 
          (session.livekitRoom && this.terminatingSessions.has(session.livekitRoom))) {
        this.logger.log(`[CALL-LIFECYCLE] Session ${callSid} (id=${session.id}) is already being terminated. Skipping duplicate.`);
        return;
      }

      // Add all aliases to in-memory lock
      this.terminatingSessions.add(callSid);
      this.terminatingSessions.add(session.id);
      if (session.reason) this.terminatingSessions.add(session.reason);
      if (session.livekitRoom) this.terminatingSessions.add(session.livekitRoom);

      setTimeout(() => {
        this.terminatingSessions.delete(callSid);
        this.terminatingSessions.delete(session.id);
        if (session.reason) this.terminatingSessions.delete(session.reason);
        if (session.livekitRoom) this.terminatingSessions.delete(session.livekitRoom);
      }, 10000);

      // Terminate SIP Participant in LiveKit (Idempotent)
      let terminationResult = 'not_applicable';
      if (session.livekitRoom) {
        terminationResult = await this.livekitService.terminateLiveKitCall(session.livekitRoom, callSid, session.livekitSipParticipantIdentity || undefined);
      }

      // If termination returned not_found, the participant/room has already closed.
      // We must NEVER abort early, as that strands calls in RINGING / IN_PROGRESS (Fix DEF-05).
      if (terminationResult === 'not_found') {
        this.logger.log(`[CALL-LIFECYCLE] LiveKit room/participant already closed. Proceeding to finalize DB session ${callSid}`);
      }

      // Release global capacity channel
      if (this.capacityService) {
        await this.capacityService.releaseChannel(callSid, (session.transferHistory as any)?.provider || 'vobiz').catch(() => {});
      }

      let finalDuration = duration;
      if ((!finalDuration || finalDuration <= 0) && session.createdAt) {
        const elapsed = Math.floor((Date.now() - new Date(session.createdAt).getTime()) / 1000);
        if (elapsed > 0 && session.status !== 'RINGING') {
          finalDuration = elapsed;
        }
      }

      const isOutbound = (session.transferHistory as any)?.direction === 'outbound' || 
                         session.livekitRoom?.startsWith('call_outbound_') || 
                         session.reason?.startsWith('call_outbound_');

      let finalStatus: string;
      if (finalDuration > 0 || session.status === 'IN_PROGRESS' || session.status === 'CONNECTED') {
        finalStatus = 'ENDED';
      } else {
        const normalizedReason = (reason || session.reason || '').toLowerCase();
        if (normalizedReason.includes('busy') || normalizedReason === 'user_busy') {
          finalStatus = 'BUSY';
        } else if (normalizedReason.includes('failed') || normalizedReason.includes('rejected')) {
          finalStatus = 'FAILED';
        } else if (normalizedReason === 'explicit_user_end' || normalizedReason === 'agent_cancelled' || normalizedReason === 'cancelled') {
          finalStatus = isOutbound ? 'CANCELLED' : 'MISSED';
        } else if (normalizedReason === 'timeout' || normalizedReason === 'no-answer' || normalizedReason === 'customer_no_answer') {
          finalStatus = isOutbound ? 'UNANSWERED' : 'MISSED';
        } else {
          finalStatus = isOutbound ? 'UNANSWERED' : 'MISSED';
        }
      }

      await this.prisma.callSession.update({
        where: { id: session.id },
        data: {
          endedAt: new Date(),
          duration: finalDuration,
          status: finalStatus as any,
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

      // Phase 16: Release agent reservation lock and reset active call capacity
      if (session.calleeUserId) {
        await this.queueService.releaseAgentReservation(session.calleeUserId, callSid).catch(() => {});
      }
      for (const p of session.participants || []) {
        if (p.agentId) {
          await this.queueService.releaseAgentReservation(p.agentId, callSid).catch(() => {});
        }
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

      this.logger.log(`[CALL-LIFECYCLE-DIAG] callId=${callSid} stage=CALL_TERMINATED source=endCallSession timestamp=${new Date().toISOString()} finalStatus=${finalStatus} duration=${finalDuration}`);

      // Emit callEnded with all correlation aliases so frontend clears active call immediately
      this.telephonyGateway.server.emit('callEnded', {
        callSid: session.reason || callSid,
        roomName: session.livekitRoom || callSid,
        sessionId: session.id,
        duration: finalDuration,
        status: finalStatus,
      });

      this.logger.log(`[CALL-LIFECYCLE-DIAG] callId=${callSid} stage=CLEANUP_COMPLETED source=endCallSession timestamp=${new Date().toISOString()}`);
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

      const th = (r.transferHistory && typeof r.transferHistory === 'object') ? (r.transferHistory as any) : {};
      const latestAudit = r.transferAudits?.[0];
      const firstAgentPart = r.participants.find(p => p.role === 'AGENT');
      let handlingAgentName = 'Unassigned';
      let handlingAgentId = firstAgentPart?.agentId || null;
      let department = 'General';

      if (th.currentAgentName) {
        handlingAgentName = th.currentAgentName;
        handlingAgentId = th.currentAgentId || handlingAgentId;
        department = th.toDepartment || latestAudit?.destinationAgent?.department || department;
      } else if (latestAudit?.destinationAgent?.name) {
        handlingAgentName = latestAudit.destinationAgent.name;
        handlingAgentId = latestAudit.destinationAgent.id;
        department = latestAudit.destinationAgent.department || department;
      } else if (firstAgentPart?.agentId) {
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
      const instagram = (r.customer as any)?.instagramUsername || (r.customer as any)?.platformUserId;

      const availableChannels: any[] = [];
      if (phone && !phone.startsWith('ig_')) {
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
          platformUserId: (r.customer as any)?.platformUserId || null,
          instagramUsername: (r.customer as any)?.instagramUsername || null,
        },
        conversationId: r.conversationId || null,
        isTransferred: (r.transferAudits?.length || 0) > 0 || !!th.transfers?.length,
        transferCount: r.transferAudits?.length || th.transfers?.length || 0,
        transferredFrom: th.lastTransferredFrom || latestAudit?.initiatingAgent?.name || (latestAudit?.metadata as any)?.transferredFrom || null,
        transferredTo: th.lastTransferredTo || latestAudit?.destinationAgent?.name || (latestAudit?.metadata as any)?.transferredTo || null,
        transfers: r.transferAudits,
        transferHistory: th,
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
        handlingAgent: (session.transferHistory as any)?.currentAgentName
          ? {
              name: (session.transferHistory as any).currentAgentName,
              department: (session.transferHistory as any).toDepartment || session.callee?.agentProfile?.department || 'General Care',
            }
          : (session.caller?.agentProfile || session.callee?.agentProfile || null),
        transfers: session.transferAudits,
        transferHistory: session.transferHistory,
        transferredFrom: (session.transferHistory as any)?.lastTransferredFrom || session.transferAudits?.[0]?.initiatingAgent?.name || null,
        transferredTo: (session.transferHistory as any)?.lastTransferredTo || session.transferAudits?.[0]?.destinationAgent?.name || null,
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

    const livekitWsUrl = process.env.LIVEKIT_WS_URL || 'wss://23jy3gv6xcs.livekit.cloud';

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
          transferredFrom: initiatingAgent.name,
          transferredTo: destinationAgent.name,
          sourceDepartment: initiatingAgent.department || 'General',
          destDepartment: destinationDepartment || destinationAgent.department || 'General',
        }
      },
      include: {
        initiatingAgent: { select: { id: true, name: true, department: true } },
        destinationAgent: { select: { id: true, name: true, department: true } },
      }
    });

    // 1. Update transferHistory chain and session status
    const existingHistory = (session.transferHistory && typeof session.transferHistory === 'object') ? (session.transferHistory as any) : {};
    if (!Array.isArray(existingHistory.transfers)) {
      existingHistory.transfers = [];
    }
    existingHistory.transfers.push({
      transferAuditId: transferAudit.id,
      transferredAt: new Date().toISOString(),
      fromAgentId: initiatingAgent.id,
      fromAgentName: initiatingAgent.name,
      fromDepartment: initiatingAgent.department || 'General',
      toAgentId: destinationAgent.id,
      toAgentName: destinationAgent.name,
      toDepartment: destinationDepartment || destinationAgent.department || 'General',
      transferMode,
      reason: reason || 'Live Call Transfer',
      status: transferMode === 'BLIND' ? 'TRANSFERRED' : 'INITIATED',
    });
    existingHistory.currentAgentId = destinationAgent.id;
    existingHistory.currentAgentName = destinationAgent.name;
    existingHistory.lastTransferredFrom = initiatingAgent.name;
    existingHistory.lastTransferredTo = destinationAgent.name;

    await this.prisma.callSession.update({
      where: { id: session.id },
      data: {
        transferHistory: existingHistory,
        calleeUserId: destinationAgent.userId || destinationAgent.id,
        status: transferMode === 'BLIND' ? 'TRANSFERRED' : session.status,
      }
    });

    // 2. If BLIND transfer, detach initiating agent audio and mark available
    if (transferMode === 'BLIND') {
      await this.prisma.agent.update({
        where: { id: initiatingAgent.id },
        data: { status: 'AVAILABLE' }
      }).catch(() => {});

      await this.prisma.callParticipant.updateMany({
        where: { callSessionId: session.id, agentId: initiatingAgent.id, leftAt: null },
        data: { leftAt: new Date() }
      }).catch(() => {});

      if (this.livekitService) {
        try {
          const participants = await this.livekitService.listParticipants(roomName);
          const sanitizedName = initiatingAgent.name.replace(/\s+/g, '_');
          const initPart = participants.find(p => p.identity.includes(sanitizedName));
          if (initPart) {
            await this.livekitService.removeParticipant(roomName, initPart.identity);
          }
        } catch (e: any) {
          this.logger.warn(`Could not remove initiating agent from LiveKit: ${e.message}`);
        }
      }

      if (initiatingAgent.socketId) {
        this.telephonyGateway.server.to(initiatingAgent.socketId).emit('callTransferredOut', {
          callSid: session.reason || session.id,
          roomName,
          transferredTo: destinationAgent.name,
        });
      }
      this.telephonyGateway.server.emit('callTransferredOut', {
        initiatingAgentId: initiatingAgent.id,
        callSid: session.reason || session.id,
        roomName,
        transferredTo: destinationAgent.name,
      });
    }

    // 3. Dispatch incoming call event to destination agent with LiveKit credentials
    const incomingCallPayload = {
      callSid: session.reason || session.id,
      callSessionId: session.id,
      roomName,
      caller: session.customer?.phone || session.lead?.phoneNumber || 'Customer',
      phone: session.customer?.phone || session.lead?.phoneNumber || 'Customer',
      customerName: session.customer?.name || session.lead?.customerName || 'Customer',
      isTransfer: true,
      transferAuditId: transferAudit.id,
      transferMode,
      transferReason: reason || 'Live Call Transfer',
      destinationAgentId: destinationAgent.id,
      destinationUserId: destinationAgent.userId,
      assignedAgent: {
        id: destinationAgent.id,
        name: destinationAgent.name,
        department: destinationAgent.department,
      },
      sourceAgent: {
        id: initiatingAgent.id,
        name: initiatingAgent.name,
        department: initiatingAgent.department,
      },
      token: destToken,
      serverUrl: livekitWsUrl,
      wsUrl: livekitWsUrl,
      category: 'Inbound',
      direction: 'INBOUND',
    };

    this.telephonyGateway.dispatchIncomingCallToAgent(destinationAgent.socketId, incomingCallPayload);

    // Also broadcast targeted incoming_call_transfer
    this.telephonyGateway.server.emit('incoming_call_transfer', {
      destinationDepartment: destinationAgent.department,
      ...incomingCallPayload,
    });

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
          include: { 
            transferAudits: { 
              orderBy: { createdAt: 'desc' }, 
              take: 1,
              include: { destinationAgent: true, initiatingAgent: true }
            } 
          }
        })
      : await this.prisma.callSession.findFirst({
          where: { OR: [{ reason: callSid }, { livekitRoom: callSid }] },
          include: { 
            transferAudits: { 
              orderBy: { createdAt: 'desc' }, 
              take: 1,
              include: { destinationAgent: true, initiatingAgent: true }
            } 
          }
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

      if (latestAudit.initiatingAgentId) {
        await this.prisma.callParticipant.updateMany({
          where: { callSessionId: session.id, agentId: latestAudit.initiatingAgentId, leftAt: null },
          data: { leftAt: new Date() }
        }).catch(() => {});

        await this.prisma.agent.update({
          where: { id: latestAudit.initiatingAgentId },
          data: { status: 'AVAILABLE' }
        }).catch(() => {});

        const initAgent = await this.prisma.agent.findUnique({ where: { id: latestAudit.initiatingAgentId } });
        if (initAgent?.socketId) {
          this.telephonyGateway.server.to(initAgent.socketId).emit('callTransferredOut', {
            callSid: session.reason || session.id,
            roomName: session.livekitRoom,
          });
        }

        this.telephonyGateway.server.emit('callTransferredOut', {
          initiatingAgentId: latestAudit.initiatingAgentId,
          callSid: session.reason || session.id,
          roomName: session.livekitRoom,
          transferredTo: latestAudit.destinationAgent?.name || 'Agent',
        });

        if (this.livekitService && session.livekitRoom && initAgent) {
          try {
            const participants = await this.livekitService.listParticipants(session.livekitRoom);
            const sanitizedName = initAgent.name.replace(/\s+/g, '_');
            const initPart = participants.find(p => p.identity.includes(sanitizedName));
            if (initPart) {
              await this.livekitService.removeParticipant(session.livekitRoom, initPart.identity);
              this.logger.log(`[CALL-TRANSFER] Detached transferring agent ${initAgent.name} from LiveKit room ${session.livekitRoom}`);
            }
          } catch (e: any) {
            this.logger.warn(`Could not remove initiating agent from LiveKit during complete: ${e.message}`);
          }
        }
      }
    }

    const th = (session.transferHistory && typeof session.transferHistory === 'object') ? (session.transferHistory as any) : {};
    if (Array.isArray(th.transfers) && th.transfers.length > 0) {
      th.transfers[th.transfers.length - 1].status = 'COMPLETED';
      th.transfers[th.transfers.length - 1].completedAt = new Date().toISOString();
    }

    await this.prisma.callSession.update({
      where: { id: session.id },
      data: {
        status: 'TRANSFERRED',
        transferHistory: th,
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

      // Phase 16: Queue Classification & Emergency Priority Check
      const isEmergency = Boolean(
        (customerContext?.customer as any)?.servicePlans?.some((p: any) => p.planType === 'EMERGENCY' || p.planType === 'AMBULANCE') ||
        (customerContext?.customer as any)?.isEmergency
      );

      let assignedAgent = null;
      for (let i = 0; i < 5; i++) {
        const potentialAgent = await this.queueService.allocateAgent({
          department: isEmergency ? 'EMERGENCY' : undefined,
          isEmergency,
          callSid: event.providerCallId,
          ringTimeoutSeconds: isEmergency ? 15 : 25,
          strategy: 'LONGEST_IDLE',
        });
        if (!potentialAgent) break; // No agents available in pool

        let isSocketConnected = false;
        if (potentialAgent.socketId) {
          const directSocket = this.telephonyGateway.server?.sockets?.sockets?.get(potentialAgent.socketId);
          if (directSocket?.connected) {
            isSocketConnected = true;
          } else {
            const sockets = await this.telephonyGateway.server.in(potentialAgent.socketId).fetchSockets();
            if (sockets.length > 0) isSocketConnected = true;
          }
        }

        if (isSocketConnected) {
          assignedAgent = potentialAgent;
          break; // Found an active, connected agent
        }

        // Stale socket detected: release reservation lock and mark offline
        this.logger.warn(`Allocated agent ${potentialAgent.name} but socket ${potentialAgent.socketId} is dead. Releasing reservation and marking offline.`);
        await this.queueService.releaseAgentReservation(potentialAgent.id, event.providerCallId);
        await this.prisma.agent.update({
          where: { id: potentialAgent.id },
          data: { status: 'OFFLINE', activeCalls: 0, socketId: null }
        });
      }

      // Global Capacity Reservation for Inbound Call
      if (this.capacityService) {
        const capRes = await this.capacityService.reserveChannel('INBOUND', event.providerCallId, event.provider || 'vobiz');
        if (!capRes.success) {
          this.logger.warn(`[INBOUND-CAPACITY] Carrier capacity limit reached: ${capRes.reason}. Enqueueing to waiting pool.`);
          await this.queueService.enqueueCallItem(
            event.providerCallId,
            customerContext?.customer?.id,
            isEmergency ? 'EMERGENCY' : 'GENERAL',
            isEmergency ? 'EMERGENCY' : 'NORMAL'
          );
          return false;
        }
      }

      if (!assignedAgent) {
        // Fallback: Attempt allocation through QueueService ensuring atomic locks and socket checks are strictly preserved (Fix DEF-03)
        assignedAgent = await this.queueService.allocateAgent({
          department: isEmergency ? 'EMERGENCY' : undefined,
          isEmergency,
          callSid: event.providerCallId,
        });
      }

      this.logger.log(`[INBOUND-TRACE] AGENT_SELECTION | callId=${event.providerCallId} assignedAgentId=${assignedAgent?.id}`);

      if (!assignedAgent) {
        this.logger.warn(`No agents available for call ${event.providerCallId}. Enqueueing to waiting pool.`);
        await this.queueService.enqueueCallItem(
          event.providerCallId,
          customerContext?.customer?.id,
          isEmergency ? 'EMERGENCY' : 'GENERAL',
          isEmergency ? 'EMERGENCY' : 'NORMAL'
        );
        return false;
      }

      this.logger.log(`[INBOUND-TRACE] PROVIDER_SELECTION | callId=${event.providerCallId} provider=${event.provider}`);
      this.logger.log(`[INBOUND-TRACE] MEDIA_ROUTING | callId=${event.providerCallId} routing_to=livekit`);

      // Fix DEF-01: Deterministic room naming aligned with LiveKit and Vobiz bridge XML
      const roomName = `call_${event.providerCallId}`;
      event.roomName = roomName;

      this.logger.log(`[INBOUND-LIVEKIT] Established deterministic roomName=${roomName} for callId=${event.providerCallId}`);

      // Fix DEF-01: Asynchronous non-blocking background discovery of LiveKit SIP participant (reduces webhook delay from 10s to <100ms)
      setTimeout(async () => {
        try {
          const livekitRoomInfo = await this.livekitService.findInboundSipRoom(event.fromNumber, 5, 1000);
          if (livekitRoomInfo) {
            this.logger.log(`[INBOUND-LIVEKIT-SYNC] Discovered SIP participant=${livekitRoomInfo.participantIdentity} in room=${livekitRoomInfo.roomName}`);
            await this.prisma.callSession.updateMany({
              where: { reason: event.providerCallId },
              data: {
                livekitSipParticipantIdentity: livekitRoomInfo.participantIdentity,
              },
            });
          }
        } catch (syncErr: any) {
          this.logger.debug(`[INBOUND-LIVEKIT-SYNC] Background check: ${syncErr.message}`);
        }
      }, 1500);

      if (event.direction === 'INBOUND') {
        this.logger.log(`[INBOUND-CALL] session_create_start | caller=${event.fromNumber} DID=${event.toNumber} providerCallUUID=${event.providerCallId}`);
      }

      // Await session creation to ensure persistence before dispatch (Fix DEF-06: pass customerContext?.lead?.id)
      try {
        const session = await this.createCallSession(
          event.providerCallId,
          roomName,
          customerContext?.customer?.id,
          assignedAgent.userId,
          event.direction || 'inbound',
          event.fromNumber,
          customerContext?.lead?.id, // Fix DEF-06: Associate Lead!
        );

        // LiveKit SIP participant identity is synchronized asynchronously in background task (Fix DEF-01)

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

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetCallSid);
      const session = await this.prisma.callSession.findFirst({
        where: isUuid
          ? { OR: [{ id: targetCallSid }, { reason: targetCallSid }, { livekitRoom: targetCallSid }] }
          : { OR: [{ reason: targetCallSid }, { livekitRoom: targetCallSid }, { livekitRoom: `call_${targetCallSid}` }] }
      });

      const roomName = session?.livekitRoom || `call_${targetCallSid}`;
      const reasonSid = session?.reason || targetCallSid;

      this.logger.log(`[CALL-LIFECYCLE-DIAG] callId=${reasonSid} stage=CUSTOMER_ANSWERED source=${event.provider}_inbound_connected timestamp=${new Date().toISOString()}`);

      this.telephonyGateway.server.emit('callConnected', {
        callSid: reasonSid,
        roomName: roomName,
        sessionId: session?.id,
        answeredAt: new Date().toISOString()
      });
      return true;
    }

    if (['CALL_ENDED', 'CALL_MISSED', 'CALL_FAILED'].includes(event.eventType)) {
      let targetCallSid = event.providerCallId;

      this.logger.log(`[CALL-LIFECYCLE-DIAG] callId=${targetCallSid} stage=CALL_TERMINATED source=${event.provider}_carrier_webhook timestamp=${new Date().toISOString()} reason=${event.eventType}`);

      await this.endCallSession(targetCallSid, event.duration, event.recordingUrl, true, event.eventType);
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

    // Global Capacity Orchestration: Check & Reserve Channel before dialing
    if (this.capacityService) {
      // Check inbound queue depth to enforce priority policy
      const queueDashboard = await this.queueService.getQueueOperationsDashboard().catch(() => null);
      const queueDepth = queueDashboard?.waitingCalls || 0;

      const reservation = await this.capacityService.reserveChannel('OUTBOUND', callSid, providerType, { queueDepth });
      if (!reservation.success) {
        this.logger.warn(`[OUTBOUND-CAPACITY] Blocked dial to ${request.to}: reason=${reservation.reason}`);
        return {
          success: false,
          reason: reservation.reason,
          message: reservation.reason === 'THROTTLED_INBOUND_PRIORITY'
            ? 'Outbound dialing temporarily paused: Inbound customer calls are waiting in queue.'
            : 'Telephony channel capacity limit reached. Please wait for an active call to conclude.',
        };
      }
    }

    try {
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

    this.logger.log(`[CALL-LIFECYCLE-DIAG] callId=${callSid} stage=CALL_INITIATED source=initiateOutboundCall timestamp=${new Date().toISOString()} direction=OUTBOUND to=${request.to} roomName=${roomName}`);

    // NOTE: Removed premature 2-second recording timer.
    // Recording begins strictly when the customer answers the call (CUSTOMER_ANSWERED stage).

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
    } catch (err: any) {
      if (this.capacityService) {
        await this.capacityService.releaseChannel(callSid, providerType).catch(() => {});
      }
      this.logger.error(`[OUTBOUND-FAIL] Call initiation failed: ${err.message}`);
      throw err;
    }
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

  /**
   * Dispatches an outbound message to the external provider (WhatsApp, Instagram, or Email)
   * Validates credentials, recipient formats, captures provider message IDs,
   * and returns verified delivery or provider rejection details.
   */
  async dispatchExternalMessage(
    channel: string,
    recipient: string,
    content: string,
    options?: { subject?: string }
  ): Promise<{
    success: boolean;
    provider: string;
    providerMessageId?: string;
    status: 'SENT' | 'FAILED';
    deliveryStatus: string;
    error?: string;
    code?: string;
    details?: any;
  }> {
    const channelUpper = (channel || 'WHATSAPP').toUpperCase();

    // 1. WHATSAPP (Meta Cloud API with Twilio fallback)
    if (channelUpper === 'WHATSAPP') {
      const cleanPhone = String(recipient || '').replace(/^whatsapp:/i, '').replace(/[^0-9+]/g, '').trim();
      if (!cleanPhone || cleanPhone.replace(/[^0-9]/g, '').length < 8) {
        return {
          success: false,
          provider: 'WHATSAPP',
          status: 'FAILED',
          deliveryStatus: 'REJECTED_INVALID_RECIPIENT',
          error: 'Recipient must be a valid phone number with country code for WhatsApp (minimum 8 digits)',
          code: 'INVALID_RECIPIENT_FORMAT',
        };
      }

      // 1a. Try Meta WhatsApp Cloud API if configured
      const metaToken = process.env.WHATSAPP_TOKEN;
      const metaPhoneId = process.env.WHATSAPP_PHONE_ID;
      let lastError: any = null;

      if (metaToken && metaPhoneId) {
        try {
          const url = `https://graph.facebook.com/v22.0/${metaPhoneId}/messages`;
          const toFormatted = cleanPhone.replace(/^\+/, '');
          const res = await (fetch as any)(url, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${metaToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: toFormatted,
              type: 'text',
              text: { body: content },
            }),
          });
          const data = await res.json();
          if (res.ok && data?.messages?.[0]?.id) {
            this.logger.log(`[WhatsApp Provider] Delivered via Meta Cloud API. MID: ${data.messages[0].id}`);
            return {
              success: true,
              provider: 'META_WHATSAPP',
              providerMessageId: data.messages[0].id,
              status: 'SENT',
              deliveryStatus: 'ACCEPTED_BY_PROVIDER',
            };
          }
          lastError = data?.error || new Error('Meta WhatsApp Cloud API rejected request');
          this.logger.warn(`[WhatsApp Provider] Meta Cloud API failed: ${lastError.message || JSON.stringify(lastError)}. Falling back to Twilio...`);
        } catch (metaErr: any) {
          lastError = metaErr;
          this.logger.warn(`[WhatsApp Provider] Meta Cloud API exception: ${metaErr.message}. Falling back to Twilio...`);
        }
      }

      // 1b. Fallback to Twilio WhatsApp (verified active account)
      const twilioSid = process.env.TWILIO_ACCOUNT_SID;
      const twilioToken = process.env.TWILIO_AUTH_TOKEN;
      const twilioFrom = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';

      if (twilioSid && twilioToken) {
        try {
          const twilio = require('twilio');
          const twilioClient = twilio(twilioSid, twilioToken);
          const formattedTo = cleanPhone.startsWith('whatsapp:') ? cleanPhone : `whatsapp:${cleanPhone.startsWith('+') ? cleanPhone : '+' + cleanPhone}`;
          const twilioRes = await twilioClient.messages.create({
            from: twilioFrom,
            to: formattedTo,
            body: content,
          });

          this.logger.log(`[WhatsApp Provider] Delivered via Twilio WhatsApp. SID: ${twilioRes.sid}`);
          return {
            success: true,
            provider: 'TWILIO_WHATSAPP',
            providerMessageId: twilioRes.sid,
            status: 'SENT',
            deliveryStatus: 'ACCEPTED_BY_PROVIDER',
          };
        } catch (twilioErr: any) {
          this.logger.error(`[WhatsApp Provider] Twilio WhatsApp failed: ${twilioErr.message}`);
          return {
            success: false,
            provider: 'TWILIO_WHATSAPP',
            status: 'FAILED',
            deliveryStatus: 'REJECTED_BY_PROVIDER',
            error: `WhatsApp Delivery Failed: ${twilioErr.message}`,
            code: String(twilioErr.code || 'TWILIO_DELIVERY_FAILED'),
            details: twilioErr,
          };
        }
      }

      return {
        success: false,
        provider: 'WHATSAPP',
        status: 'FAILED',
        deliveryStatus: 'PROVIDER_NOT_CONFIGURED',
        error: lastError ? `Meta error: ${lastError.message}. No active Twilio credentials configured.` : 'No WhatsApp provider configured (missing Meta and Twilio credentials).',
        code: 'PROVIDER_NOT_CONFIGURED',
      };
    }

    // 2. INSTAGRAM (Meta Graph API / Messenger API for Instagram)
    if (channelUpper === 'INSTAGRAM') {
      const cleanIgId = String(recipient || '').replace(/^ig_/, '').trim();
      
      // Validate that recipient is an Instagram Scoped User ID, not a raw phone number
      if (cleanIgId.startsWith('+') || (/^\d{8,12}$/.test(cleanIgId) && !cleanIgId.startsWith('17841') && !cleanIgId.startsWith('1506'))) {
        return {
          success: false,
          provider: 'META_INSTAGRAM',
          status: 'FAILED',
          deliveryStatus: 'REJECTED_INVALID_RECIPIENT',
          error: 'Instagram delivery requires a valid Meta Instagram Scoped ID (IGSID). Instagram Direct Message API does not accept phone numbers.',
          code: 'INVALID_RECIPIENT_TYPE',
        };
      }

      const metaToken = process.env.META_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || process.env.ACCESS_TOKEN;
      if (!metaToken) {
        return {
          success: false,
          provider: 'META_INSTAGRAM',
          status: 'FAILED',
          deliveryStatus: 'PROVIDER_NOT_CONFIGURED',
          error: 'Meta Page Access Token is not configured for Instagram delivery',
          code: 'PROVIDER_NOT_CONFIGURED',
        };
      }

      try {
        const url = 'https://graph.facebook.com/v22.0/me/messages';
        const res = await (fetch as any)(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${metaToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipient: { id: cleanIgId },
            messaging_type: 'RESPONSE',
            message: { text: content },
          }),
        });

        const data = await res.json();
        if (res.ok && data?.message_id) {
          this.logger.log(`[Instagram Provider] Delivered via Meta Graph API. MID: ${data.message_id}`);
          return {
            success: true,
            provider: 'META_INSTAGRAM',
            providerMessageId: data.message_id,
            status: 'SENT',
            deliveryStatus: 'ACCEPTED_BY_PROVIDER',
          };
        }

        const errMsg = data?.error?.message || 'Meta Graph API rejected message delivery';
        const errCode = data?.error?.code || 'META_API_ERROR';
        this.logger.error(`[Instagram Provider] Meta Graph API error (${errCode}): ${errMsg}`);
        return {
          success: false,
          provider: 'META_INSTAGRAM',
          status: 'FAILED',
          deliveryStatus: 'REJECTED_BY_PROVIDER',
          error: `Instagram Delivery Failed (${errCode}): ${errMsg}`,
          code: String(errCode),
          details: data?.error,
        };
      } catch (igErr: any) {
        this.logger.error(`[Instagram Provider] Exception during Meta call: ${igErr.message}`);
        return {
          success: false,
          provider: 'META_INSTAGRAM',
          status: 'FAILED',
          deliveryStatus: 'REJECTED_NETWORK_ERROR',
          error: `Instagram Network Error: ${igErr.message}`,
          code: 'NETWORK_ERROR',
        };
      }
    }

    // 3. EMAIL (Nodemailer SMTP)
    if (channelUpper === 'EMAIL') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(recipient.trim())) {
        return {
          success: false,
          provider: 'EMAIL',
          status: 'FAILED',
          deliveryStatus: 'REJECTED_INVALID_RECIPIENT',
          error: 'Invalid recipient email format',
          code: 'INVALID_EMAIL_FORMAT',
        };
      }

      const emailUser = process.env.EMAIL_USER;
      const emailPass = process.env.EMAIL_PASS;
      if (!emailUser || !emailPass) {
        return {
          success: false,
          provider: 'EMAIL',
          status: 'FAILED',
          deliveryStatus: 'PROVIDER_NOT_CONFIGURED',
          error: 'Email service credentials not configured (EMAIL_USER/EMAIL_PASS missing)',
          code: 'PROVIDER_NOT_CONFIGURED',
        };
      }

      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: process.env.EMAIL_HOST || 'smtp.gmail.com',
          port: parseInt(process.env.EMAIL_PORT || '465', 10) || 465,
          secure: true,
          auth: { user: emailUser, pass: emailPass },
        });

        const subject = options?.subject || 'ElderCare Support Update';
        const info = await transporter.sendMail({
          from: `"ElderCare CRM" <${emailUser}>`,
          to: recipient.trim(),
          subject,
          text: content,
          html: `<div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden;"><div style="background-color: #f97316; padding: 20px; text-align: center;"><h2 style="color: white; margin: 0;">ElderCare Support</h2></div><div style="padding: 20px;"><p style="white-space: pre-wrap;">${content}</p></div></div>`,
        });

        this.logger.log(`[Email Provider] Delivered via SMTP. Message ID: ${info.messageId}`);
        return {
          success: true,
          provider: 'EMAIL',
          providerMessageId: info.messageId,
          status: 'SENT',
          deliveryStatus: 'ACCEPTED_BY_PROVIDER',
        };
      } catch (mailErr: any) {
        this.logger.error(`[Email Provider] SMTP error: ${mailErr.message}`);
        return {
          success: false,
          provider: 'EMAIL',
          status: 'FAILED',
          deliveryStatus: 'REJECTED_BY_PROVIDER',
          error: `Email Delivery Failed: ${mailErr.message}`,
          code: 'EMAIL_SEND_FAILED',
        };
      }
    }

    return {
      success: false,
      provider: channelUpper,
      status: 'FAILED',
      deliveryStatus: 'UNSUPPORTED_CHANNEL',
      error: `Unsupported communication channel: ${channelUpper}`,
      code: 'UNSUPPORTED_CHANNEL',
    };
  }

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
        const cleanPhone = body.recipient.replace(/^whatsapp:/i, '').trim();
        customer = await this.prisma.customer.findFirst({
          where: {
            OR: [
              { phone: cleanPhone },
              { phone: body.recipient.trim() }
            ]
          }
        });
      } else if (channelUpper === 'INSTAGRAM') {
        const cleanIg = body.recipient.replace(/^ig_/, '').trim();
        customer = await this.prisma.customer.findFirst({
          where: {
            OR: [
              { platformUserId: cleanIg },
              { phone: cleanIg },
              { phone: `ig_${cleanIg}` }
            ]
          }
        });
      } else if (channelUpper === 'EMAIL') {
        customer = await this.prisma.customer.findFirst({
          where: { email: { equals: body.recipient.trim(), mode: 'insensitive' } }
        });
      }
    }

    if (!customer) {
      const isIg = channelUpper === 'INSTAGRAM';
      const cleanIg = isIg ? body.recipient.replace(/^ig_/, '').trim() : null;
      customer = await this.prisma.customer.create({
        data: {
          name: lead?.customerName || (isIg && cleanIg ? `Instagram User (${cleanIg.slice(-4)})` : (channelUpper === 'EMAIL' ? body.recipient.split('@')[0] : `Customer ${body.recipient}`)),
          phone: isIg && cleanIg ? `ig_${cleanIg}` : (channelUpper === 'WHATSAPP' ? body.recipient.trim().replace(/^whatsapp:/i, '') : (lead?.phoneNumber || `+91${Date.now().toString().slice(-10)}`)),
          email: channelUpper === 'EMAIL' ? body.recipient.trim() : (lead?.email || null),
          platform: isIg ? 'INSTAGRAM' : (channelUpper === 'WHATSAPP' ? 'WHATSAPP' : null),
          platformUserId: cleanIg || null,
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

    // DISPATCH MESSAGE VIA ACTUAL PROVIDER (Meta Cloud API, Twilio WhatsApp, Meta Graph API, or Nodemailer)
    const dispatchResult = await this.dispatchExternalMessage(
      channelUpper,
      body.recipient.trim(),
      body.message.trim(),
      { subject: body.subject }
    );

    // If Provider Rejected Delivery, persist as FAILED and report exact error
    if (!dispatchResult.success) {
      const failedMessage = await this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          content: body.message.trim(),
          senderType: 'AGENT',
          status: 'FAILED',
          isAiSuggested: false,
        }
      });

      if (lead) {
        await this.prisma.leadActivity.create({
          data: {
            leadId: lead.id,
            callSessionId: session?.id || null,
            conversationId: conversation.id,
            agentId: user?.agentId || null,
            type: 'COMMUNICATION',
            channel: channelUpper,
            direction: 'OUTBOUND',
            title: `FAILED Outbound ${channelUpper} to ${body.recipient}`,
            content: body.message.trim(),
            status: 'FAILED',
            metadata: {
              error: dispatchResult.error,
              code: dispatchResult.code,
              provider: dispatchResult.provider,
              deliveryStatus: dispatchResult.deliveryStatus,
              failedAt: new Date().toISOString(),
              senderUserId: user?.id || user?.userId || null,
            }
          }
        });
      }

      try {
        this.telephonyGateway.server.emit('omnichannelMessageFailed', {
          conversationId: conversation.id,
          messageId: failedMessage.id,
          channel: channelUpper,
          recipient: body.recipient,
          error: dispatchResult.error,
          code: dispatchResult.code,
          timestamp: new Date().toISOString(),
        });
      } catch (_) {}

      throw new BadRequestException({
        success: false,
        message: dispatchResult.error || 'Provider rejected message delivery',
        code: dispatchResult.code || 'PROVIDER_DELIVERY_FAILED',
        provider: dispatchResult.provider,
        deliveryStatus: dispatchResult.deliveryStatus,
        conversationId: conversation.id,
        messageId: failedMessage.id,
        status: 'FAILED',
      });
    }

    // Provider accepted delivery: persist as SENT
    const providerMessageId = dispatchResult.providerMessageId || `msg_${channelUpper.toLowerCase()}_${Date.now()}`;

    const messageRecord = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        content: body.message.trim(),
        senderType: 'AGENT',
        status: 'SENT',
        isAiSuggested: false,
      }
    });

    // Save to WhatsappLog if WhatsApp
    if (channelUpper === 'WHATSAPP') {
      try {
        await this.prisma.whatsappLog.create({
          data: {
            conversationId: conversation.id,
            phone: body.recipient.trim(),
            message: body.message.trim(),
            direction: 'OUTBOUND',
            status: 'SENT',
            twilioSid: providerMessageId,
          }
        });
      } catch (_) {}
    }

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
            provider: dispatchResult.provider,
            deliveryStatus: dispatchResult.deliveryStatus,
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
        providerMessageId,
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
      provider: dispatchResult.provider,
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








