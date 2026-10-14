import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { AgentService } from '../agent/agent.service';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class ApiGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ApiGateway.name);

  constructor(private readonly agentService: AgentService) {}

  async handleConnection(client: Socket) {
    const authToken = client.handshake.auth.token;
    // In production: Validate JWT here
    this.logger.log(`Client connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    // Extract agentId from socket context and mark OFFLINE
    // await this.agentService.updateAgentStatus(agentId, 'OFFLINE');
  }

  @SubscribeMessage('agent_status_change')
  async handleAgentStatusChange(
    client: Socket,
    payload: { agentId: string; status: any },
  ) {
    await this.agentService.updateAgentStatus(payload.agentId, payload.status);
    return { event: 'status_updated', data: payload.status };
  }

  // WebRTC Signaling
  @SubscribeMessage('sdp_offer')
  handleSdpOffer(client: Socket, payload: { targetId: string; sdp: any }) {
    this.server.to(payload.targetId).emit('sdp_offer', payload.sdp);
  }

  @SubscribeMessage('ice_candidate')
  handleIceCandidate(
    client: Socket,
    payload: { targetId: string; candidate: any },
  ) {
    this.server.to(payload.targetId).emit('ice_candidate', payload.candidate);
  }
}
