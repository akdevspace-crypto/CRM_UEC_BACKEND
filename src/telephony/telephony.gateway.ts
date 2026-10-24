import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, Inject, forwardRef, Optional } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { TelephonyService } from './telephony.service';
import { LivekitService } from './livekit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentStatus } from '@prisma/client';
import * as jwt from 'jsonwebtoken';

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class TelephonyGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private readonly logger: Logger = new Logger(TelephonyGateway.name);

  // Multi-socket tracking per agent: Map<agentId, Set<socketId>>
  private readonly agentSockets: Map<string, Set<string>> = new Map();

  // Reverse mapping for fast lookups on disconnect: Map<socketId, AgentSession>
  private readonly socketToAgent: Map<
    string,
    {
      agentId: string;
      userId: string;
      name: string;
      department?: string;
      loginTime: Date;
    }
  > = new Map();

  constructor(
    @Inject(forwardRef(() => TelephonyService)) private readonly telephonyService: TelephonyService,
    private readonly livekitService: LivekitService,
    private readonly prisma: PrismaService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redisClient?: any,
  ) {}

  afterInit(server: Server) {
    this.logger.log('Telephony WebSocket Gateway initialized with strict handshake auth middleware');

    // Strict Handshake Authentication Middleware
    server.use(async (socket: Socket, next: (err?: any) => void) => {
      try {
        const auth = socket.handshake.auth || {};
        const headers = socket.handshake.headers || {};
        const query = socket.handshake.query || {};

        let rawToken: any =
          auth.token ||
          auth.accessToken ||
          headers.authorization ||
          (query.token as string);

        if (!rawToken || typeof rawToken !== 'string') {
          this.logger.warn(
            `[WS-AUTH] status=REJECTED category=MISSING_TOKEN socketId=${socket.id} reason="No token provided in handshake auth or headers"`
          );
          return next(new Error('AUTHENTICATION_REQUIRED: Token missing in handshake'));
        }

        // Sanitize: strip Bearer prefix, surrounding quotes, and whitespace
        const sanitizedToken = rawToken
          .replace(/^Bearer\s+/i, '')
          .trim()
          .replace(/^["']|["']$/g, '');

        if (!sanitizedToken) {
          this.logger.warn(
            `[WS-AUTH] status=REJECTED category=EMPTY_TOKEN socketId=${socket.id} reason="Token empty after sanitization"`
          );
          return next(new Error('AUTHENTICATION_REQUIRED: Token empty'));
        }

        // Safe Diagnostics: Decode unverified header & payload without logging token or secrets
        let decodedHeader: any = null;
        let decodedPayload: any = null;
        try {
          const decoded = jwt.decode(sanitizedToken, { complete: true }) as any;
          if (decoded) {
            decodedHeader = decoded.header;
            decodedPayload = decoded.payload;
          }
        } catch (_) {}

        const alg = decodedHeader?.alg || 'unknown';
        const iss = decodedPayload?.iss || 'none';
        const aud = decodedPayload?.aud || 'none';
        const exp = decodedPayload?.exp
          ? new Date(decodedPayload.exp * 1000).toISOString()
          : 'none';
        const candidateAgentOrUser =
          decodedPayload?.agentId ||
          decodedPayload?.userId ||
          decodedPayload?.sub ||
          'unknown';

        // Cryptographic Verification: Secret, Algorithm (HS256), Expiry, Claims
        const secret = process.env.JWT_SECRET || 'crm-secure-jwt-secret-key-2026';
        const verifyOptions: jwt.VerifyOptions = {
          algorithms: ['HS256'],
        };
        if (process.env.JWT_ISSUER) verifyOptions.issuer = process.env.JWT_ISSUER;
        if (process.env.JWT_AUDIENCE) verifyOptions.audience = process.env.JWT_AUDIENCE;

        let authenticatedUser: any = null;
        try {
          authenticatedUser = jwt.verify(sanitizedToken, secret, verifyOptions);
        } catch (err: any) {
          let category = 'JWT_VERIFICATION_FAILED';
          if (err instanceof jwt.TokenExpiredError) {
            category = 'TOKEN_EXPIRED';
          } else if (err instanceof jwt.JsonWebTokenError) {
            if (err.message.includes('invalid signature')) {
              category = 'INVALID_SIGNATURE';
            } else if (err.message.includes('jwt malformed')) {
              category = 'MALFORMED_TOKEN';
            } else if (err.message.includes('invalid algorithm')) {
              category = 'INVALID_ALGORITHM';
            } else if (err.message.includes('jwt issuer invalid')) {
              category = 'INVALID_ISSUER';
            } else if (err.message.includes('jwt audience invalid')) {
              category = 'INVALID_AUDIENCE';
            }
          }

          this.logger.warn(
            `[WS-AUTH] status=REJECTED category=${category} socketId=${socket.id} agentId=${candidateAgentOrUser} alg=${alg} iss=${iss} aud=${aud} exp=${exp} reason="${err.message}"`
          );
          return next(new Error(`AUTH_REJECTED: ${category}`));
        }

        if (
          !authenticatedUser ||
          (!authenticatedUser.userId && !authenticatedUser.sub && !authenticatedUser.id)
        ) {
          this.logger.warn(
            `[WS-AUTH] status=REJECTED category=MISSING_USER_CLAIMS socketId=${socket.id} agentId=${candidateAgentOrUser} alg=${alg} iss=${iss} exp=${exp} reason="Token missing userId or sub claim"`
          );
          return next(new Error('AUTH_REJECTED: MISSING_USER_CLAIMS'));
        }

        // Attach verified user payload to socket
        socket.data.user = authenticatedUser;

        this.logger.log(
          `[WS-AUTH] status=AUTHENTICATED socketId=${socket.id} agentId=${authenticatedUser.agentId || authenticatedUser.userId || authenticatedUser.sub} alg=${alg} iss=${iss} exp=${exp}`
        );
        return next();
      } catch (unexpectedErr: any) {
        this.logger.error(
          `[WS-AUTH] status=REJECTED category=INTERNAL_ERROR socketId=${socket.id} reason="${unexpectedErr.message}"`
        );
        return next(new Error('AUTH_REJECTED: INTERNAL_ERROR'));
      }
    });
  }

  handleConnection(client: Socket) {
    const user = client.data?.user;
    const agentId = user?.agentId || user?.userId || user?.sub || 'unregistered';
    this.logger.log(
      `[WS-CONNECT] Client connected: socketId=${client.id} authenticated=${Boolean(user)} agentId=${agentId}`
    );
  }

  /**
   * Helper: Retrieve all active and connected sockets for an agent
   */
  public getActiveSocketsForAgent(agentId: string): string[] {
    const socketsSet = this.agentSockets.get(agentId);
    if (!socketsSet || socketsSet.size === 0) return [];

    const activeSockets: string[] = [];
    for (const socketId of socketsSet) {
      const client = this.server?.sockets?.sockets?.get(socketId);
      if (client && client.connected) {
        activeSockets.push(socketId);
      }
    }

    // Prune stale disconnected entries if necessary
    if (activeSockets.length !== socketsSet.size) {
      this.agentSockets.set(agentId, new Set(activeSockets));
    }

    return activeSockets;
  }

  /**
   * Idempotently register a socket for an agent in the multi-socket registry
   */
  public async registerAgentSocket(agent: any, client: Socket): Promise<void> {
    const agentId = agent.id;
    let socketSet = this.agentSockets.get(agentId);
    if (!socketSet) {
      socketSet = new Set<string>();
      this.agentSockets.set(agentId, socketSet);
    }

    const wasAlreadyAvailable = socketSet.size > 0 && agent.status === 'AVAILABLE';
    socketSet.add(client.id);

    this.socketToAgent.set(client.id, {
      agentId,
      userId: agent.userId,
      name: agent.name,
      department: agent.department,
      loginTime: new Date(),
    });

    // Sync to Redis for legacy compatibility if available
    if (this.redisClient) {
      try {
        const agentData = {
          agentId: agent.id,
          name: agent.name,
          skills: agent.department,
          status: 'AVAILABLE',
          socketId: client.id,
        };
        await this.redisClient.set(`agent:${client.id}`, JSON.stringify(agentData));
      } catch (err: any) {
        this.logger.warn(`Failed to sync agent socket to redis: ${err.message}`);
      }
    }

    // Update database presence idempotently pointing socketId to latest active socket
    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        status: 'AVAILABLE',
        socketId: client.id,
        lastActive: new Date(),
        isDeleted: false,
        activeCalls: 0,
      },
    });

    this.logger.log(
      `[WS-PRESENCE] agentId=${agent.id} agentName=${agent.name} socketId=${client.id} activeSockets=${socketSet.size} status=AVAILABLE`
    );

    // Notify listeners only if transitioning to AVAILABLE, preventing duplicate event spam
    if (!wasAlreadyAvailable) {
      this.server.emit('agent_status_change', {
        agentId: agent.id,
        status: 'AVAILABLE',
        name: agent.name,
      });
    }
  }

  /**
   * Unregister a socket on disconnect.
   * If other active sockets exist for the agent, the agent remains AVAILABLE!
   */
  public async unregisterAgentSocket(socketId: string): Promise<void> {
    const agentSession = this.socketToAgent.get(socketId);
    let agentId = agentSession?.agentId;

    this.socketToAgent.delete(socketId);

    // Clean up Redis key
    if (this.redisClient) {
      try {
        await this.redisClient.del(`agent:${socketId}`);
      } catch (_) {}
    }

    // Fallback: look up agent by socketId in database if not found in memory
    if (!agentId) {
      try {
        const dbAgent = await this.prisma.agent.findFirst({ where: { socketId } });
        if (dbAgent) agentId = dbAgent.id;
      } catch (_) {}
    }

    if (!agentId) {
      this.logger.log(`[WS-DISCONNECT] Socket ${socketId} disconnected with no associated agent registration.`);
      return;
    }

    // Remove from in-memory set
    const socketSet = this.agentSockets.get(agentId);
    if (socketSet) {
      socketSet.delete(socketId);
    }

    // Check remaining connected sockets for this agent
    const remainingSockets = this.getActiveSocketsForAgent(agentId);

    if (remainingSockets.length > 0) {
      // AGENT STILL HAS ACTIVE SOCKET(S) (e.g. multiple tabs or rapid reconnect)
      const latestSocketId = remainingSockets[remainingSockets.length - 1];
      this.logger.log(
        `[WS-PRESENCE] Agent ${agentSession?.name || agentId} socket ${socketId} disconnected, but has ${remainingSockets.length} active socket(s): [${remainingSockets.join(', ')}]. Retaining AVAILABLE status. Updating primary socketId to ${latestSocketId}.`
      );

      try {
        await this.prisma.agent.update({
          where: { id: agentId },
          data: {
            socketId: latestSocketId,
            lastActive: new Date(),
          },
        });
      } catch (err: any) {
        this.logger.error(`Error updating latest active socket on disconnect: ${err.message}`);
      }
      return;
    }

    // NO REMAINING ACTIVE SOCKETS: Mark agent OFFLINE
    this.agentSockets.delete(agentId);
    this.logger.log(
      `[WS-PRESENCE] Agent ${agentSession?.name || agentId} has 0 remaining sockets. Marking OFFLINE.`
    );

    try {
      const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
      if (agent) {
        await this.prisma.agent.update({
          where: { id: agent.id },
          data: { status: 'OFFLINE', socketId: null },
        });
        this.server.emit('agent_status_change', {
          agentId: agent.id,
          status: 'OFFLINE',
          name: agent.name,
        });
      }
    } catch (e: any) {
      this.logger.error(`Error marking agent offline on disconnect: ${e.message}`);
    }
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`[WS-DISCONNECT] Client disconnected: socketId=${client.id}`);
    await this.unregisterAgentSocket(client.id);
  }

  @SubscribeMessage('agent_login')
  async handleAgentLogin(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    const { agentId, name } = data || {};
    this.logger.log(`Agent ${name || agentId} logging in via WebSocket (socketId: ${client.id})...`);

    // Use verified handshake user claims or re-verify if passed in message
    let authenticatedUser = client.data?.user;

    if (!authenticatedUser) {
      const rawToken =
        data?.token ||
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');

      if (!rawToken) {
        this.logger.warn(`[SECURITY] agent_login rejected for socket ${client.id}: Missing token`);
        client.emit('auth_error', { message: 'Authentication token required for agent login' });
        return;
      }

      try {
        const sanitized = String(rawToken)
          .replace(/^Bearer\s+/i, '')
          .trim()
          .replace(/^["']|["']$/g, '');
        const secret = process.env.JWT_SECRET || 'crm-secure-jwt-secret-key-2026';
        authenticatedUser = jwt.verify(sanitized, secret, { algorithms: ['HS256'] });
        client.data.user = authenticatedUser;
      } catch (err: any) {
        this.logger.warn(`[SECURITY] agent_login rejected for socket ${client.id}: ${err.message}`);
        client.emit('auth_error', { message: 'Invalid or expired authentication token' });
        return;
      }
    }

    if (!authenticatedUser || (!authenticatedUser.userId && !authenticatedUser.sub && !authenticatedUser.id)) {
      this.logger.warn(`[SECURITY] agent_login rejected for socket ${client.id}: Missing user claims`);
      client.emit('auth_error', { message: 'Invalid token claims' });
      return;
    }

    const requestedAgentId = agentId || authenticatedUser.agentId || authenticatedUser.userId || authenticatedUser.sub;

    if (requestedAgentId) {
      const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(authenticatedUser.role);
      const tokenAgentId = authenticatedUser.agentId;
      const tokenUserId = authenticatedUser.userId || authenticatedUser.sub || authenticatedUser.id;

      if (!isAdmin && tokenAgentId && tokenAgentId !== requestedAgentId && tokenUserId !== requestedAgentId) {
        this.logger.warn(
          `[SECURITY] Spoofing attempt blocked: token identity (${tokenAgentId || tokenUserId}) attempted to bind agent ${requestedAgentId}`
        );
        client.emit('auth_error', { message: 'Unauthorized: cannot impersonate other agents' });
        return;
      }

      try {
        const agent = await this.prisma.agent.findFirst({
          where: {
            OR: [{ id: requestedAgentId }, { userId: requestedAgentId }],
          },
        });

        if (agent) {
          const isOwner =
            authenticatedUser.userId === agent.userId ||
            authenticatedUser.agentId === agent.id ||
            authenticatedUser.sub === agent.userId ||
            authenticatedUser.id === agent.userId;

          if (!isOwner && !isAdmin) {
            this.logger.warn(
              `[SECURITY] Spoofing attempt blocked: user ${authenticatedUser.userId || authenticatedUser.sub} attempted to bind agent ${agent.id}`
            );
            client.emit('auth_error', { message: 'Unauthorized: cannot impersonate other agents' });
            return;
          }

          // Register in multi-socket registry
          await this.registerAgentSocket(agent, client);

          client.emit('agent_login_ack', {
            success: true,
            agentId: agent.id,
            status: 'AVAILABLE',
            socketId: client.id,
          });
        } else {
          this.logger.warn(`Agent login failed: No agent found for ID ${requestedAgentId}`);
          client.emit('auth_error', { message: 'Unauthorized: Agent not found or identity mismatch' });
          return;
        }
      } catch (e: any) {
        this.logger.error(`Agent login error: ${e.message}`);
        client.emit('auth_error', { message: 'Internal server error during login' });
      }
    }
  }

  @SubscribeMessage('status_update')
  async handleStatusUpdate(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    const { status } = data; // e.g. 'AVAILABLE', 'BUSY', 'OFFLINE'

    try {
      const agentSession = this.socketToAgent.get(client.id);
      let agent = null;

      if (agentSession) {
        agent = await this.prisma.agent.findUnique({ where: { id: agentSession.agentId } });
      } else {
        agent = await this.prisma.agent.findFirst({ where: { socketId: client.id } });
      }

      const validStatuses: AgentStatus[] = ['AVAILABLE', 'BUSY', 'BREAK', 'WRAP_UP', 'OFFLINE'];
      if (!validStatuses.includes(status)) {
        this.logger.warn(`[WS-STATUS] Invalid status update attempted: ${status} by socket ${client.id}`);
        return;
      }

      if (agent) {
        const isStatusChanged = agent.status !== status;

        if (isStatusChanged) {
          await this.prisma.agent.update({
            where: { id: agent.id },
            data: { status, lastActive: new Date() },
          });
        } else {
          // Idempotent: update lastActive without triggering duplicate broadcasts or state thrashing
          await this.prisma.agent.update({
            where: { id: agent.id },
            data: { lastActive: new Date() },
          });
        }

        // Sync Redis if available
        if (this.redisClient) {
          try {
            const redisAgentStr = await this.redisClient.get(`agent:${client.id}`);
            if (redisAgentStr) {
              const parsed = JSON.parse(redisAgentStr);
              parsed.status = status;
              await this.redisClient.set(`agent:${client.id}`, JSON.stringify(parsed));
            }
          } catch (_) {}
        }

        // Only emit event to connected clients if the status actually changed
        if (isStatusChanged) {
          this.logger.log(`Agent ${agent.name} changed status from ${agent.status} to ${status}`);
          this.server.emit('agent_status_change', { agentId: agent.id, status, name: agent.name });
        }
      }
    } catch (e: any) {
      this.logger.error(`Status update error: ${e.message}`);
    }
  }

  /**
   * Deterministic Call Dispatching:
   * Ensures exactly-once delivery targeting the agent's current active socket.
   * If the requested socketId is stale or disconnected, resolves the agent's latest connected socket.
   */
  dispatchIncomingCallToAgent(
    targetSocketId: string | null | undefined,
    payload: any,
  ) {
    const assignedAgentId = payload.assignedAgent?.id || payload.destinationAgent?.id || payload.agentId;
    this.logger.log(
      `[INBOUND-E2E] STEP=GATEWAY_METHOD_ENTERED | agentId=${assignedAgentId} agentName=${payload.assignedAgent?.name} callId=${payload.callSid} roomName=${payload.roomName} provider=${payload.source} direction=${payload.direction || 'INBOUND'}`
    );

    let resolvedSocketId = targetSocketId;

    // Check if the provided socketId is still active and connected
    const targetSocket = resolvedSocketId ? this.server?.sockets?.sockets?.get(resolvedSocketId) : null;
    const isTargetConnected = Boolean(targetSocket && targetSocket.connected);

    if (!isTargetConnected && assignedAgentId) {
      const activeSockets = this.getActiveSocketsForAgent(assignedAgentId);
      if (activeSockets.length > 0) {
        // Resolve to the most recent active socket for deterministic ownership
        resolvedSocketId = activeSockets[activeSockets.length - 1];
        this.logger.log(
          `[INBOUND-E2E] Re-routed call ${payload.callSid} from stale socket ${targetSocketId} to active socket ${resolvedSocketId} for agent ${assignedAgentId}`
        );
      }
    }

    this.logger.log(
      `[INBOUND-E2E] STEP=SOCKET_TARGET_RESOLVED | agentId=${assignedAgentId} socketId=${resolvedSocketId} socketConnected=${Boolean(resolvedSocketId && this.server?.sockets?.sockets?.get(resolvedSocketId)?.connected)} targetType=individual_socket`
    );

    if (resolvedSocketId && this.server?.sockets?.sockets?.get(resolvedSocketId)?.connected) {
      this.logger.log(
        `[INBOUND-CALL] gateway_emit | CallSid=${payload.callSid} roomName=${payload.roomName} caller=${payload.caller} DID=${payload.phone} direction=${payload.direction || 'INBOUND'} token_exists=${Boolean(payload.token)}`
      );
      this.logger.log(
        `Dispatching targeted incoming_call event to agent socket: ${resolvedSocketId}`
      );
      this.logger.log(`[INBOUND-E2E] STEP=SOCKET_EMIT | event=incoming_call socketId=${resolvedSocketId} tokenPresent=${Boolean(payload.token)}`);

      // Emit payload and TCP flush buffer
      this.server.to(resolvedSocketId).emit('incoming_call', payload);
      this.logger.log(`[INBOUND-E2E] STEP=SOCKET_EMIT_COMPLETE`);
      this.server.to(resolvedSocketId).emit('proxy_flush', ' '.repeat(131072));
      this.logger.log('SUCCESS: Emit executed for specific socket');
    } else {
      this.logger.warn(
        `No active connected socket found for assigned agent (${payload.assignedAgent?.name || assignedAgentId}). Skipping emit to avoid unassigned ringing leakage.`
      );
    }
  }

  @SubscribeMessage('acceptCall')
  async handleAcceptCall(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`Agent accepted call: ${data.callSid}`);
    const agentId = data.agentId || client.handshake.auth?.agentId || client.data?.user?.agentId;

    if (!agentId) {
      this.logger.error(`No agentId provided for acceptCall ${data.callSid}`);
      return;
    }

    await this.telephonyService.acceptCallSession(data.callSid, agentId);
  }

  @SubscribeMessage('callAnswered')
  async handleCallAnswered(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`[CALL-LIFECYCLE-DIAG] callId=${data.callSid} stage=CUSTOMER_ANSWERED source=frontend_sip_active timestamp=${new Date().toISOString()}`);
    if (data.callSid) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.callSid);
      const session = await this.prisma.callSession.findFirst({
        where: isUuid
          ? { OR: [{ id: data.callSid }, { reason: data.callSid }, { livekitRoom: data.callSid }] }
          : { OR: [{ reason: data.callSid }, { livekitRoom: data.callSid }] },
      });

      if (!session) {
        this.logger.warn(`[CALL-LIFECYCLE] handleCallAnswered: No session found for callSid=${data.callSid}`);
        return;
      }

      const isTerminal = ['ENDED', 'MISSED', 'CANCELLED', 'UNANSWERED', 'BUSY', 'FAILED', 'REJECTED'].includes(session.status);
      if (isTerminal || this.telephonyService.isSessionTerminatedOrTerminating(session.id) || (session.reason && this.telephonyService.isSessionTerminatedOrTerminating(session.reason))) {
        this.logger.warn(`[CALL-LIFECYCLE] handleCallAnswered: Ignored late answer for already terminated session ${session.id} (status=${session.status})`);
        return;
      }

      await this.prisma.callSession.update({
        where: { id: session.id },
        data: {
          status: 'IN_PROGRESS',
          startedAt: session.startedAt || new Date(),
        }
      }).catch(() => {});

      // Broadcast callConnected to all sockets for this call with aliases
      this.server.emit('callConnected', {
        callSid: session.reason || data.callSid,
        roomName: session.livekitRoom || data.roomName || data.callSid,
        sessionId: session.id,
        answeredAt: new Date().toISOString()
      });

      // Start recording on answer if roomName provided (deduplicated in TelephonyService)
      const roomToRecord = session.livekitRoom || data.roomName;
      if (roomToRecord) {
        await this.telephonyService.startLivekitRecording(session.reason || data.callSid, roomToRecord).catch((err: any) => {
          this.logger.warn(`Failed to auto-start recording on answer: ${err.message}`);
        });
      }
    }
  }

  @SubscribeMessage('startRecording')
  async handleStartRecording(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`[CALL-RECORDING] event=START_REQUEST callId=${data.callSid} roomName=${data.roomName}`);
    await this.telephonyService.startLivekitRecording(data.callSid, data.roomName);
  }

  @SubscribeMessage('endCall')
  async handleEndCall(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    if (!data?.callSid) {
      this.logger.warn('[CALL-TERMINATION] endCall received without callSid. Ignored.');
      return;
    }

    let validatedReason = data.reason;
    if (!validatedReason) {
      this.logger.warn(
        `[CALL-TERMINATION] endCall received with missing or undefined reason for callSid=${data.callSid}. Applying explicit fallback reason 'explicit_user_end'.`,
      );
      validatedReason = 'explicit_user_end';
    }

    this.logger.log(
      `Call ended by frontend: ${data.callSid}, duration: ${data.duration}, reason: ${validatedReason}`,
    );

    const nonDestructiveDisconnectReasons = [
      'webrtc_disconnected',
      'room_disconnected',
      'client_disconnected',
      'network_disconnected'
    ];

    // CRITICAL: Do not terminate the PSTN/SIP call solely because the frontend WebRTC or room temporarily disconnects!
    if (nonDestructiveDisconnectReasons.includes(validatedReason)) {
      this.logger.warn(
        `[CALL-LIFECYCLE] Rejecting premature endCall with reason='${validatedReason}' for callSid=${data.callSid}. PSTN/SIP call preserved.`,
      );
      return;
    }

    if (this.telephonyService.isSessionTerminatedOrTerminating(data.callSid)) {
      this.logger.log(
        `[CALL-TERMINATION] Session ${data.callSid} already terminating or ended. Skipping duplicate endCall from socket.`,
      );
      return;
    }

    await this.telephonyService.endCallSession(
      data.callSid,
      data.duration,
      null,
      false,
      validatedReason,
    );
  }

  @SubscribeMessage('initiateTransfer')
  async handleInitiateTransfer(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`Transfer initiated via socket: callSid=${data.callSid} destDept=${data.destinationDepartment}`);
    try {
      const res = await this.telephonyService.initiateCallTransfer(data.callSid, data, client.data?.user || (client as any).user || data.user);
      client.emit('transfer_initiated_ack', res);
    } catch (e: any) {
      this.logger.error(`Failed to initiate transfer via socket: ${e.message}`);
      client.emit('transfer_error', { message: e.message });
    }
  }

  @SubscribeMessage('completeTransfer')
  async handleCompleteTransfer(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`Transfer completed via socket: callSid=${data.callSid}`);
    try {
      const res = await this.telephonyService.completeCallTransfer(data.callSid, data, client.data?.user || (client as any).user || data.user);
      client.emit('transfer_completed_ack', res);
    } catch (e: any) {
      this.logger.error(`Failed to complete transfer via socket: ${e.message}`);
      client.emit('transfer_error', { message: e.message });
    }
  }

  @SubscribeMessage('cancelTransfer')
  async handleCancelTransfer(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`Transfer cancelled via socket: callSid=${data.callSid}`);
    try {
      const res = await this.telephonyService.cancelCallTransfer(data.callSid, data, client.data?.user || (client as any).user || data.user);
      client.emit('transfer_cancelled_ack', res);
    } catch (e: any) {
      this.logger.error(`Failed to cancel transfer via socket: ${e.message}`);
      client.emit('transfer_error', { message: e.message });
    }
  }
}
