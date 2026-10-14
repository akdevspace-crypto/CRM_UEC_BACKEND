import { Controller, Post, Req, Logger, Header } from '@nestjs/common';
import type { Request } from 'express';
import { TelephonyService } from './telephony.service';
import { VobizProvider } from './providers/vobiz.provider';
import { Public } from '../api-gateway/auth.guard';

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
    const payload = req.body;
    const event = this.vobizProvider.normalizeWebhookEvent(payload, req.method);
    await this.telephonyService.processNormalizedEvent(event, req);
    return 'OK';
  }

  private getBaseUrl(req: Request) {
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = Array.isArray(forwardedHost) ? forwardedHost[0] : (forwardedHost || req.get('host'));
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    return `${protocol}://${host}`;
  }
}
