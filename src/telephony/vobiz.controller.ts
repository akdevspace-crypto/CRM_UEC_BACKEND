import { Controller, Post, Get, Req, Logger, Header, HttpCode, HttpStatus, UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { TelephonyService } from './telephony.service';
import { VobizProvider } from './providers/vobiz.provider';
import { Public } from '../api-gateway/auth.guard';
import * as crypto from 'crypto';

@Controller(['vobiz', 'telephony/vobiz'])
export class VobizController {
  private readonly logger = new Logger(VobizController.name);

  constructor(
    private readonly telephonyService: TelephonyService,
    private readonly vobizProvider: VobizProvider,
  ) {}

  @Public()
  @Get('incoming')
  @HttpCode(HttpStatus.OK)
  async probeIncoming() {
    return { status: 'ok', endpoint: '/vobiz/incoming', provider: 'vobiz', timestamp: new Date() };
  }

  @Public()
  @Post('incoming')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/xml')
  async handleVobizIncoming(@Req() req: Request) {
    this.logger.log(`Received incoming call webhook from Vobiz`);
    this.verifySignature(req);
    const payload = req.body;

    const fromCaller = payload?.From || payload?.CallFrom;
    if (!fromCaller) {
      throw new BadRequestException('From caller number is required');
    }
    
    // Normalize event using Vobiz Provider
    const event = this.vobizProvider.normalizeWebhookEvent(payload, req.method);
    
    // Process event asynchronously/non-blocking
    const processed = await this.telephonyService.processNormalizedEvent(event, req);
    
    // Fix DEF-01: Deterministic room naming aligned with LiveKit SIP
    const roomName = event.roomName || `call_${event.providerCallId || Date.now()}`;

    // If capacity exhausted or call rejected, return busy/overflow XML
    if (processed === false && (!event.roomName || payload?.Status === 'busy')) {
      return this.vobizProvider.generateBusyResponse?.() || this.vobizProvider.generateBridgeResponse(roomName, this.getBaseUrl(req));
    }

    return this.vobizProvider.generateBridgeResponse(roomName, this.getBaseUrl(req));
  }

  @Public()
  @Get('status')
  @HttpCode(HttpStatus.OK)
  async probeStatus() {
    return { status: 'ok', endpoint: '/vobiz/status', provider: 'vobiz', timestamp: new Date() };
  }

  @Public()
  @Post('status')
  @HttpCode(HttpStatus.OK)
  async handleVobizStatus(@Req() req: Request) {
    this.verifySignature(req);
    const payload = req.body;
    const event = this.vobizProvider.normalizeWebhookEvent(payload, req.method);
    await this.telephonyService.processNormalizedEvent(event, req);
    return 'OK';
  }

  private verifySignature(req: Request): boolean {
    const secret = process.env.VOBIZ_WEBHOOK_SECRET || process.env.VOBIZ_AUTH_TOKEN;
    const signature = (req.headers['x-vobiz-signature'] || req.headers['x-signature'] || req.headers['x-hub-signature-256']) as string;
    const enforce = process.env.VOBIZ_ENFORCE_SIGNATURE === 'true';

    if (!secret) {
      if (enforce) {
        throw new UnauthorizedException('Carrier webhook secret not configured');
      }
      return true;
    }

    if (!signature) {
      if (enforce) {
        throw new UnauthorizedException('Carrier webhook signature header missing');
      }
      return true;
    }

    try {
      const rawBody = (req as any).rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      const cleanSig = signature.replace(/^sha256=/i, '');
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const sigBuf = Buffer.from(cleanSig, 'utf8');
      const expBuf = Buffer.from(expected, 'utf8');

      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        this.logger.warn(`[SECURITY] Invalid carrier webhook signature on ${req.originalUrl}`);
        throw new ForbiddenException('Invalid carrier webhook signature');
      }
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof UnauthorizedException) throw err;
      throw new ForbiddenException('Failed to validate carrier webhook signature');
    }
  }

  private getBaseUrl(req: Request) {
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = Array.isArray(forwardedHost) ? forwardedHost[0] : (forwardedHost || req.get('host'));
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    if (forwardedHost && host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
      return `${protocol}://${host}`;
    }
    if (process.env.BASE_URL && process.env.BASE_URL.startsWith('http')) {
      return process.env.BASE_URL.replace(/\/$/, '');
    }
    if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
      return `${protocol}://${host}`;
    }
    return 'https://crm-uec-backend.onrender.com';
  }
}
