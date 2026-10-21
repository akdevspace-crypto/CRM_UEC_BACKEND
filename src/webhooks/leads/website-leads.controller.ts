import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Headers,
  Req,
  Res,
  Logger,
  HttpStatus,
  HttpCode,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../api-gateway/auth.guard';
import { Roles } from '../../api-gateway/roles.guard';
import { Throttle } from '@nestjs/throttler';
import { WebsiteLeadsService } from './website-leads.service';

@Controller(['api/v1/webhooks/leads', 'webhooks/leads'])
export class WebsiteLeadsController {
  private readonly logger = new Logger(WebsiteLeadsController.name);

  constructor(private readonly websiteLeadsService: WebsiteLeadsService) {}

  /**
   * Health and configuration status of all 7 website integrations.
   * Restrict access to SUPER_ADMIN and ADMIN roles only.
   * GET /api/v1/webhooks/leads/sources/status
   */
  @Get('sources/status')
  @Roles('SUPER_ADMIN', 'ADMIN')
  async getSourcesStatus() {
    return {
      status: 'ok',
      totalSources: 7,
      sources: this.websiteLeadsService.getSourceStatuses(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Safe test ping for a specific website integration.
   * Restrict to SUPER_ADMIN.
   * POST /api/v1/webhooks/leads/sources/:sourceId/test
   */
  @Post('sources/:sourceId/test')
  @Roles('SUPER_ADMIN')
  @HttpCode(HttpStatus.OK)
  async testSourcePing(
    @Param('sourceId') sourceId: string,
    @Body() body: any,
  ) {
    const simulateLead = !!body?.simulateLead;
    return await this.websiteLeadsService.testSourcePing(sourceId, simulateLead);
  }

  /**
   * Historical batch import / synchronization endpoint.
   * Restrict to SUPER_ADMIN.
   * POST /api/v1/webhooks/leads/sources/:sourceId/sync
   */
  @Post('sources/:sourceId/sync')
  @Roles('SUPER_ADMIN')
  @HttpCode(HttpStatus.OK)
  async syncSourceHistorical(
    @Param('sourceId') sourceId: string,
    @Body() body: any,
  ) {
    const records = body?.records || body?.sampleRecords || [];
    const dryRun = body?.dryRun !== false;
    const options = {
      dryRun,
      checkpoint: body?.checkpoint,
      simulateInterruptionAtIndex: body?.simulateInterruptionAtIndex,
    };

    return await this.websiteLeadsService.syncHistoricalLeads(sourceId, records, options);
  }

  /**
   * Primary Webhook Ingestion API.
   * Independently authenticated per source via HMAC-SHA256 signature or shared secret.
   * Rate limited: 60 requests per minute per IP.
   * POST /api/v1/webhooks/leads/:sourceId
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Post(':sourceId')
  async handleIncomingLeadWebhook(
    @Param('sourceId') sourceId: string,
    @Body() body: any,
    @Headers() headers: Record<string, any>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Enforce payload size limit (256 KB)
    const contentLength = parseInt(headers['content-length'] || '0', 10);
    if (contentLength > 256 * 1024) {
      this.logger.warn(`Rejected oversized webhook payload (${contentLength} bytes) from ${sourceId}`);
      return res.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
        error: 'Payload Too Large: Maximum allowed webhook size is 256KB',
      });
    }

    // Capture raw body buffer if available
    const rawBodyBuffer = (req as any).rawBody || (req as any).body;

    try {
      const result = await this.websiteLeadsService.processWebhookLead(
        sourceId,
        body,
        headers,
        rawBodyBuffer,
      );

      // Return HTTP 201 for new records; HTTP 200 for updates and idempotency duplicates
      const statusCode = result.status === 'created' ? HttpStatus.CREATED : HttpStatus.OK;
      return res.status(statusCode).json(result);
    } catch (err: any) {
      const status = err.getStatus ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
      const message = err.message || 'Internal server error processing website lead';
      return res.status(status).json({
        success: false,
        sourceId,
        error: message,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
