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
  async getCallHistoryLegacy(@Req() req: Request) {
    return await this.telephonyService.getCallHistory((req as any).user);
  }

  @Get('call-history')
  async getComprehensiveCallHistory(@Req() req: Request) {
    return await this.telephonyService.getComprehensiveCallHistory(req.query, (req as any).user);
  }

  @Get('call-history/:id')
  async getCallRecordDetail(@Param('id') id: string, @Req() req: Request) {
    return await this.telephonyService.getCallRecordDetail(id, (req as any).user);
  }

  @Get('departments')
  async getDepartments() {
    return await this.telephonyService.getDepartmentsAndAgents();
  }

  @Post('calls/:callSid/transfer/initiate')
  async initiateCallTransfer(
    @Param('callSid') callSid: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    return await this.telephonyService.initiateCallTransfer(callSid, body, (req as any).user);
  }

  @Post('calls/:callSid/transfer/complete')
  async completeCallTransfer(
    @Param('callSid') callSid: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    return await this.telephonyService.completeCallTransfer(callSid, body, (req as any).user);
  }

  @Post('calls/:callSid/transfer/cancel')
  async cancelCallTransfer(
    @Param('callSid') callSid: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    return await this.telephonyService.cancelCallTransfer(callSid, body, (req as any).user);
  }

  @Get('transfers')
  async getTransferAudits(@Req() req: Request) {
    return await this.telephonyService.getTransferAudits(req.query, (req as any).user);
  }

  @Post('calls/:id/send-message')
  async sendMessageFromCall(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    return await this.telephonyService.sendMessageFromCall(id, body, (req as any).user);
  }

  @Get('customer-history/:identifier')
  async getCustomerHistoryIntelligence(
    @Param('identifier') identifier: string,
    @Req() req: Request,
  ) {
    return await this.telephonyService.getCustomerHistoryIntelligence(identifier, (req as any).user);
  }

  @Post('leads/:leadId/cross-unit-transfer/preview')
  async previewCrossUnitLeadTransfer(
    @Param('leadId') leadId: string,
    @Body('destinationUnitId') destinationUnitId: string,
    @Req() req: Request,
  ) {
    return await this.telephonyService.previewCrossUnitLeadTransfer(leadId, destinationUnitId, (req as any).user);
  }

  @Post('leads/:leadId/cross-unit-transfer')
  async executeCrossUnitLeadTransfer(
    @Param('leadId') leadId: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    return await this.telephonyService.executeCrossUnitLeadTransfer(leadId, body, (req as any).user);
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
    const livekitConfigured = !!(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
    const vobizConfigured = !!(process.env.VOBIZ_AUTH_TOKEN || process.env.VOBIZ_WEBHOOK_SECRET);
    return {
      status: 'ok',
      provider: process.env.TELEPHONY_PROVIDER || 'vobiz',
      livekit: livekitConfigured ? 'connected' : 'missing_credentials',
      vobiz: vobizConfigured ? 'configured' : 'missing_credentials'
    };
  }

  private getBaseUrl(req: Request) {
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = Array.isArray(forwardedHost) ? forwardedHost[0] : (forwardedHost || req.get('host'));
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    return `${protocol}://${host}`;
  }

  @Get('calls/:callId/playback-url')
  async getCallPlaybackUrl(@Param('callId') callId: string, @Req() req: any, @Res() res: Response) {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isUuid = UUID_REGEX.test(callId);

    const sessionData = isUuid
      ? await this.prisma.callSession.findUnique({
          where: { id: callId },
          include: { participants: true },
        })
      : await this.prisma.callSession.findFirst({
          where: { OR: [{ reason: callId }, { livekitRoom: callId }] },
          include: { participants: true },
        });

    if (!sessionData) {
      return res.status(404).json({ success: false, error: 'Call session not found' });
    }

    const user = req.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user.role);
    if (!isElevated) {
      const isCaller = sessionData.callerUserId === user?.userId || sessionData.callerUserId === user?.id || sessionData.callerUserId === user?.sub;
      const isCallee = sessionData.calleeUserId === user?.userId || sessionData.calleeUserId === user?.id || sessionData.calleeUserId === user?.sub;
      const isParticipant = sessionData.participants?.some(
        (p: any) => p.agentId === user?.agentId || p.agentId === user?.userId || p.agentId === user?.id || p.agentId === user?.sub
      );

      if (!isCaller && !isCallee && !isParticipant) {
        return res.status(403).json({ success: false, error: 'Forbidden: You do not have permission to access this call recording' });
      }
    }

    const recordingStatus = sessionData.recordingStatus || (sessionData.recordingUrl ? 'READY' : 'NOT_AVAILABLE');
    if (recordingStatus !== 'READY') {
      return res.json({
        success: false,
        callId: sessionData.id,
        recordingStatus,
        recordingUrl: null,
        duration: sessionData.recordingDuration || sessionData.duration || 0,
        message: `Recording status is ${recordingStatus}`,
      });
    }

    const jwt = require('jsonwebtoken');
    const jwtSecret = process.env.JWT_SECRET || 'crm-secure-jwt-secret-key-2026';
    const token = jwt.sign(
      {
        sub: user?.userId || user?.id || user?.sub || 'anonymous',
        userId: user?.userId || user?.id || user?.sub || 'anonymous',
        role: user?.role || 'AGENT',
        callId: sessionData.id,
      },
      jwtSecret,
      { expiresIn: '2h' }
    );

    const baseUrl = this.getBaseUrl(req);
    const recordingUrl = `${baseUrl}/telephony/calls/${sessionData.id}/recording?token=${token}`;

    return res.json({
      success: true,
      callId: sessionData.id,
      recordingStatus: 'READY',
      recordingUrl,
      duration: sessionData.recordingDuration || sessionData.duration || 0,
      expiresIn: 7200,
    });
  }

  @Get('calls/:callId/recording')
  async getCallRecording(@Param('callId') callId: string, @Req() req: any, @Res() res: Response) {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isUuid = UUID_REGEX.test(callId);

    const sessionData = isUuid
      ? await this.prisma.callSession.findUnique({
          where: { id: callId },
          include: { participants: true },
        })
      : await this.prisma.callSession.findFirst({
          where: { OR: [{ reason: callId }, { livekitRoom: callId }] },
          include: { participants: true },
        });

    if (!sessionData) {
      return res.status(404).send('Recording not ready or call not found');
    }

    // Role and Resource-level Authorization (Phase 6)
    const user = req.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user.role);

    // If a call-scoped token is used, strictly enforce call matching
    if (user?.callId && user.callId !== sessionData.id && user.callId !== sessionData.reason && user.callId !== sessionData.livekitRoom) {
      this.logger.warn(`[SECURITY] Cross-call token mismatch attempt: token callId=${user.callId} vs requested=${callId}`);
      return res.status(403).json({ error: 'Forbidden: Playback token is invalid for this call' });
    }

    if (!isElevated) {
      const isCallScopedToken = user?.callId && user.callId === callId;
      const isCaller = sessionData.callerUserId === user?.userId || sessionData.callerUserId === user?.id || sessionData.callerUserId === user?.sub;
      const isCallee = sessionData.calleeUserId === user?.userId || sessionData.calleeUserId === user?.id || sessionData.calleeUserId === user?.sub;
      const isParticipant = sessionData.participants?.some(
        (p: any) => p.agentId === user?.agentId || p.agentId === user?.userId || p.agentId === user?.id || p.agentId === user?.sub
      );

      if (!isCallScopedToken && !isCaller && !isCallee && !isParticipant) {
        this.logger.warn(`[SECURITY] Unauthorized recording playback attempt for callId=${callId} by user=${user?.userId || user?.sub}`);
        return res.status(403).json({ error: 'Forbidden: You do not have permission to access this call recording' });
      }
    }

    try {
      const session = await this.telephonyService.getCallSessionRecordingUrl(callId);
      if (!session) {
        return res.status(404).send('Recording not ready or call not found');
      }

      // Stream recording with byte-range forwarding and backpressure
      const fetchHeaders: Record<string, string> = {};
      if (req.headers.range) {
        fetchHeaders['Range'] = req.headers.range;
      }

      const audioRes = await fetch(session, { headers: fetchHeaders });
      if (!audioRes.ok && audioRes.status !== 206) {
        if (audioRes.status === 416) {
          res.status(416);
          const cr = audioRes.headers.get('content-range');
          if (cr) res.setHeader('Content-Range', cr);
          return res.send('Requested Range Not Satisfiable');
        }
        this.logger.error(`[CALL-RECORDING] Upstream storage fetch failed with status=${audioRes.status}`);
        return res.status(502).json({ error: 'Failed to retrieve media from storage' });
      }

      res.status(audioRes.status);
      const upstreamContentType = audioRes.headers.get('content-type');
      const finalContentType = (upstreamContentType && !upstreamContentType.includes('mp4'))
        ? upstreamContentType
        : (sessionData.recordingMimeType || 'audio/mp4');
      res.setHeader('Content-Type', finalContentType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const contentRange = audioRes.headers.get('content-range');
      if (contentRange) {
        res.setHeader('Content-Range', contentRange);
      }
      const contentLength = audioRes.headers.get('content-length');
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }

      // Handle HEAD requests gracefully
      if (req.method === 'HEAD') {
        return res.end();
      }

      // Pipe stream with backpressure and client disconnect handling
      if (audioRes.body) {
        const { Readable } = require('stream');
        const stream = Readable.fromWeb(audioRes.body as any);
        req.on('close', () => {
          stream.destroy();
        });
        return stream.pipe(res);
      } else {
        const buffer = Buffer.from(await audioRes.arrayBuffer());
        return res.send(buffer);
      }
    } catch (err: any) {
      this.logger.error(`Error resolving recording playback for ${callId}: ${err.message}`);
      return res.status(500).send('Internal server error during recording playback');
    }
  }
}

