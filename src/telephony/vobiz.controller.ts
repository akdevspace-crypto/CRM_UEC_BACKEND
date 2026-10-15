import { Controller, Post, Req, Logger, Header, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { TelephonyService } from './telephony.service';
import { VobizProvider } from './providers/vobiz.provider';
import { Public } from '../api-gateway/auth.guard';
import * as crypto from 'crypto';

@Controller('vobiz')
export class VobizController {
  private readonly logger = new Logger(VobizController.name);

  constructor(
    private readonly telephonyService: TelephonyService,
    private readonly vobizProvider: VobizProvider,
  ) {}

  @Public()
  @Post('incoming')
  @Header('Content-Type', 'text/xml')
  async handleVobizIncoming(@Req() req: Request) {
    this.logger.log(`Received incoming call webhook from Vobiz`);
    this.verifySignature(req);
    const payload = req.body;
    
    // Normalize event using Vobiz Provider
    const event = this.vobizProvider.normalizeWebhookEvent(payload, req.method);
    
    // Idempotency check handled in service
    await this.telephonyService.processNormalizedEvent(event, req);
    
    const roomName = event.roomName || `room_${event.providerCallId || Date.now()}`;
    return this.vobizProvider.generateBridgeResponse(roomName, this.getBaseUrl(req));
  }

  @Public()
  @Post('status')
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
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    return `${protocol}://${host}`;
  }
}
