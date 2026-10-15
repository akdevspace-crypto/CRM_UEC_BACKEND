import { Controller, All, Post, Req, Res, Body, Logger, Header, Get, Inject, HttpException, Param } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LivekitService } from './livekit.service';
import { TelephonyService } from './telephony.service';
import { TelephonyGateway } from './telephony.gateway';
import { QueueService } from '../queue-orchestration/queue.service';
import { VobizProvider } from './providers/vobiz.provider';
import { ExotelProvider } from './providers/exotel.provider';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../api-gateway/auth.guard';

@Controller('telephony')
export class TelephonyController {
  private readonly logger = new Logger(TelephonyController.name);

  constructor(
    private readonly livekitService: LivekitService,
    private readonly telephonyService: TelephonyService,
    private readonly telephonyGateway: TelephonyGateway,
    private readonly queueService: QueueService,
    private readonly vobizProvider: VobizProvider,
    private readonly exotelProvider: ExotelProvider,
    private readonly prisma: PrismaService,
  ) {}

  @Get('dashboard-calls')
  async getDashboardCalls() {
    return await this.telephonyService.getDashboardCalls();
  }

  @Get('history')
  async getCallHistory(@Req() req: Request) {
    return await this.telephonyService.getCallHistory((req as any).user);
  }

  @Get('my-ringing-call')
  async getMyRingingCall(@Req() req: Request) {
    const user = (req as any).user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR'].includes(user.role);
    const agentId = isElevated
      ? ((req.query.agentId as string) || user?.agentId || user?.userId)
      : (user?.agentId || user?.userId || (req.query.agentId as string));
    if (!agentId) return { call: null };

    const result = await this.telephonyService.getMyRingingCall(agentId);
    if (!result) return { call: null };

    const { callSession, agent } = result;

    // Generate token
    const token = await this.livekitService.generateAgentToken(
      callSession.livekitRoom || `room_${Date.now()}`,
      agent.name || 'Agent',
    );

    return {
      call: {
        caller: callSession.customer?.phone || 'Unknown',
        phone: callSession.customer?.phone || 'Unknown',
        callSid: callSession.reason,
        roomName: callSession.livekitRoom,
        timestamp: callSession.createdAt.getTime(),
        source: 'vobiz',
        customerContext: { customer: callSession.customer },
        assignedAgent: { id: agent.id, name: agent.name },
        token,
      },
    };
  }



  @Public()
  @All('exotel/incoming')
  @Header('Content-Type', 'text/xml')
  async handleExotelIncoming(@Req() req: Request) {
    this.logger.log(`Received incoming call webhook from Exotel`);
    const payload = req.method === 'POST' ? req.body : req.query;
    const event = this.exotelProvider.normalizeWebhookEvent(payload, req.method);
    await this.telephonyService.processNormalizedEvent(event, req);
    return this.exotelProvider.generateBridgeResponse(event.roomName || `call_${event.providerCallId}`, this.getBaseUrl(req));
  }

  @Public()
  @All('exotel/status')
  async handleExotelStatus(@Req() req: Request) {
    const payload = req.method === 'POST' ? req.body : req.query;
    const event = this.exotelProvider.normalizeWebhookEvent(payload, req.method);
    await this.telephonyService.processNormalizedEvent(event, req);
    return 'OK';
  }

  @Post('calls/outbound')
  async initiateOutboundCall(@Body() body: any) {
    try {
      return await this.telephonyService.initiateOutboundCall(body);
    } catch (error: any) {
      this.logger.error(`Failed to initiate outbound call: ${error.message}`, error.stack);
      
      const safeError = {
        success: false,
        provider: process.env.TELEPHONY_PROVIDER || 'vobiz',
        operation: 'create_sip_participant',
        safeErrorCode: error.code || 'LIVEKIT_SIP_ERROR',
        message: 'Failed to initiate outbound call via LiveKit. Please verify trunk and connectivity.',
        requestId: `req_${Date.now()}`,
        details: error.message
      };

      // Mask sensitive info if any leaked into the message
      if (safeError.details && typeof safeError.details === 'string') {
        safeError.details = safeError.details.replace(/([a-zA-Z0-9_-]{20,})/, '***');
      }

      // Return a 500 status but with a JSON body instead of generic NestJS HTML/Exception
      throw new HttpException(safeError, 500);
    }
  }

  @Public()
  @Get('health')
  async getHealth() {
    return {
      status: 'ok',
      provider: process.env.TELEPHONY_PROVIDER || 'vobiz',
      livekit: 'connected',
      vobiz: 'configured'
    };
  }

  private getBaseUrl(req: Request) {
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = Array.isArray(forwardedHost) ? forwardedHost[0] : (forwardedHost || req.get('host'));
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    return `${protocol}://${host}`;
  }

  @Get('calls/:callId/recording')
  async getCallRecording(@Param('callId') callId: string, @Req() req: any, @Res() res: Response) {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required to access call recordings' });
    }

    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(callId)) {
      return res.status(404).send('Recording not ready or call not found');
    }

    const sessionData = await this.prisma.callSession.findUnique({
      where: { id: callId },
      include: { participants: true },
    });

    if (!sessionData) {
      return res.status(404).send('Recording not ready or call not found');
    }

    const isElevatedRole = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR'].includes(user.role);
    const isAssignedAgent = 
      sessionData.callerUserId === user.userId ||
      sessionData.calleeUserId === user.userId ||
      sessionData.participants?.some(
        (p: any) => p.agentId === user.agentId || p.agentId === user.id
      );

    if (!isElevatedRole && !isAssignedAgent) {
      this.logger.warn(`Unauthorized attempt to access call recording ${callId} by user ${user.email || user.userId}`);
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions to access this recording' });
    }

    try {
      const session = await this.telephonyService.getCallSessionRecordingUrl(callId);
      if (!session) {
        return res.status(404).send('Recording not ready or call not found');
      }
      return res.redirect(session);
    } catch (err: any) {
      this.logger.error(`Error resolving recording playback for ${callId}: ${err.message}`);
      return res.status(404).send('Recording not ready or call not found');
    }
  }
}

