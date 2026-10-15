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
import { Logger, Inject, forwardRef } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { TelephonyService } from './telephony.service';
import { LivekitService } from './livekit.service';
import { PrismaService } from '../prisma/prisma.service';
import * as jwt from 'jsonwebtoken';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class TelephonyGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private logger: Logger = new Logger('TelephonyGateway');

  constructor(
    @Inject(forwardRef(() => TelephonyService)) private readonly telephonyService: TelephonyService,
    private readonly livekitService: LivekitService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('Telephony WebSocket Gateway initialized');
  }

  handleConnection(client: Socket, ...args: any[]) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    // Find the agent by socketId and mark them offline
    try {
      const agent = await this.prisma.agent.findFirst({
        where: { socketId: client.id },
      });
      if (agent) {
        await this.prisma.agent.update({
          where: { id: agent.id },
          data: { status: 'OFFLINE', socketId: null },
        });
        this.logger.log(`Agent ${agent.name} marked OFFLINE on disconnect.`);
        this.server.emit('agent_status_change', {
          agentId: agent.id,
          status: 'OFFLINE',
        });
      }
    } catch (e) {
      this.logger.error(`Error handling disconnect: ${e.message}`);
    }
  }

  @SubscribeMessage('agent_login')
  async handleAgentLogin(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    const { agentId, name } = data;
    this.logger.log(`Agent ${name || agentId} logging in via WebSocket...`);

    const rawToken = data?.token || client.handshake.auth?.token || client.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
    if (!rawToken) {
      this.logger.warn(`[SECURITY] WebSocket authentication rejected for socket ${client.id}: Token missing`);
      client.emit('auth_error', { message: 'Authentication token required for agent login' });
      return;
    }

    let authenticatedUser: any = null;
    try {
      const secret = process.env.JWT_SECRET || 'crm-secure-jwt-secret-key-2026';
      authenticatedUser = jwt.verify(rawToken, secret);
    } catch (err: any) {
      this.logger.warn(`[SECURITY] WebSocket authentication rejected for socket ${client.id}: ${err.message}`);
      client.emit('auth_error', { message: 'Invalid or expired authentication token' });
      return;
    }

    if (!authenticatedUser || (!authenticatedUser.userId && !authenticatedUser.sub && !authenticatedUser.id)) {
      this.logger.warn(`[SECURITY] WebSocket authentication rejected for socket ${client.id}: Missing user claims`);
      client.emit('auth_error', { message: 'Invalid token claims' });
      return;
    }

    if (agentId) {
      try {
        // Find agent by Agent ID or User ID
        let agent = await this.prisma.agent.findUnique({
          where: { id: agentId },
        });
        if (!agent) {
          agent = await this.prisma.agent.findUnique({
            where: { userId: agentId },
          });
        }

        if (agent) {
          // Verify user is authorized to bind this agent socket
          const isOwner = authenticatedUser.userId === agent.userId ||
                          authenticatedUser.agentId === agent.id ||
                          authenticatedUser.sub === agent.userId ||
                          authenticatedUser.id === agent.userId;
          const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(authenticatedUser.role);
          if (!isOwner && !isAdmin) {
            this.logger.warn(`[SECURITY] WebSocket spoofing attempt blocked: user ${authenticatedUser.userId || authenticatedUser.sub} attempted to bind agent ${agent.id}`);
            client.emit('auth_error', { message: 'Unauthorized: cannot impersonate other agents' });
            return;
          }

          await this.prisma.agent.update({
            where: { id: agent.id },
            data: {
              status: 'AVAILABLE',
              socketId: client.id,
              lastActive: new Date(),
            },
          });
          this.logger.log(`[INBOUND-SOCKET-AUDIT] agentId=${agent.id} agentName=${agent.name} socketId=${client.id} connected=true authenticated=${Boolean(authenticatedUser)} socketAge=0`);
          this.logger.log(`Agent ${agent.name} is now AVAILABLE for calls.`);
          this.server.emit('agent_status_change', {
            agentId: agent.id,
            status: 'AVAILABLE',
            name: agent.name,
          });
        } else {
          this.logger.warn(
            `Agent login failed: No agent found for ID ${agentId}`,
          );
        }
      } catch (e) {
        this.logger.error(`Agent login error: ${e.message}`);
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
      const agent = await this.prisma.agent.findFirst({
        where: { socketId: client.id },
      });
      if (agent) {
        await this.prisma.agent.update({
          where: { id: agent.id },
          data: { status, lastActive: new Date() },
        });
        this.logger.log(`Agent ${agent.name} changed status to ${status}`);
        this.server.emit('agent_status_change', { agentId: agent.id, status });
      }
    } catch (e) {
      this.logger.error(`Status update error: ${e.message}`);
    }
  }

  dispatchIncomingCallToAgent(
    socketId: string | null | undefined,
    payload: any,
  ) {
    this.logger.log(`[INBOUND-E2E] STEP=GATEWAY_METHOD_ENTERED | agentId=${payload.assignedAgent?.id} agentName=${payload.assignedAgent?.name} callId=${payload.callSid} roomName=${payload.roomName} provider=${payload.source} direction=${payload.direction || 'INBOUND'}`);
    this.logger.log(`[INBOUND-E2E] STEP=SOCKET_TARGET_RESOLVED | agentId=${payload.assignedAgent?.id} socketId=${socketId} socketConnected=${!!socketId} targetType=individual_socket`);

    // Add padding to bypass Ngrok/TCP buffering issues where small payloads are held until another packet (like callEnded) arrives
    const paddedPayload = { ...payload, _padding: ' '.repeat(4096) };
    if (socketId) {
      this.logger.log(`[INBOUND-CALL] gateway_emit | CallSid=${payload.callSid} roomName=${payload.roomName} caller=${payload.caller} DID=${payload.phone} direction=${payload.direction || 'INBOUND'} token_exists=${!!payload.token}`);
      this.logger.log(
        `Dispatching targeted incoming_call event to agent socket: ${socketId}`,
      );
      this.logger.log(`[INBOUND-E2E] STEP=SOCKET_EMIT | event=incoming_call socketId=${socketId} tokenPresent=${!!payload.token}`);
      // Emit the payload and then force a flush with a massive packet
      this.server.to(socketId).emit('incoming_call', payload);
      this.logger.log(`[INBOUND-E2E] STEP=SOCKET_EMIT_COMPLETE`);
      this.server.to(socketId).emit('proxy_flush', ' '.repeat(131072)); // 128KB flush
      this.logger.log('SUCCESS: Emit executed for specific socket');
    } else {
      this.logger.warn(
        `No socketId provided for assigned agent. Fallback to global broadcast.`,
      );
      this.server.emit('incoming_call', payload);
      this.server.emit('proxy_flush', ' '.repeat(131072));
      this.logger.log('SUCCESS: Emit executed globally');
    }
  }

  @SubscribeMessage('acceptCall')
  async handleAcceptCall(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`Agent accepted call: ${data.callSid}`);
    const agentId = data.agentId || client.handshake.auth?.agentId;

    if (!agentId) {
      this.logger.error(`No agentId provided for acceptCall ${data.callSid}`);
      return;
    }

    await this.telephonyService.acceptCallSession(data.callSid, agentId);
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
    this.logger.log(
      `Call ended by frontend: ${data.callSid}, duration: ${data.duration}`,
    );
    await this.telephonyService.endCallSession(data.callSid, data.duration);

    // Emit back so frontend immediately cleans up UI
    this.server.emit('callEnded', { callSid: data.callSid });
  }
}


