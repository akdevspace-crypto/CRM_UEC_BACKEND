import { Injectable, Logger, NotFoundException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { TelephonyGateway } from '../../telephony/telephony.gateway';
import { WebsiteLeadsRegistry } from './website-leads.registry';
import { WebsiteSourceId, IngestionResult, HistoricalImportOptions, HistoricalImportResult, SourceSyncStatus } from './website-leads.types';

@Injectable()
export class WebsiteLeadsService {
  private readonly logger = new Logger(WebsiteLeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: WebsiteLeadsRegistry,
    private readonly telephonyGateway: TelephonyGateway,
  ) {}

  /**
   * Timing-safe verification of webhook HMAC-SHA256 signature or shared secret.
   * Cryptographically binds timestamp and validates replay window.
   */
  public verifyWebhookAuthentication(
    sourceId: WebsiteSourceId,
    rawBody: Buffer | string,
    headers: Record<string, any>,
  ): { authenticated: boolean; method?: 'hmac' | 'shared_secret'; signatureHex?: string; timestamp?: number } {
    const secret = this.registry.getSourceSecret(sourceId);
    if (!secret) {
      this.logger.warn(`[WebsiteLeads] No secret configured for source: ${sourceId}`);
      return { authenticated: false };
    }

    // Capture timestamp from header
    const timestampHeader = 
      headers['x-webhook-timestamp'] ||
      headers['x-timestamp'] ||
      headers['x-request-timestamp'] ||
      headers['x-signature-timestamp'];

    let tsMs = NaN;
    if (timestampHeader !== undefined && timestampHeader !== null && timestampHeader !== '') {
      if (typeof timestampHeader === 'number') {
        tsMs = timestampHeader > 1e11 ? timestampHeader : timestampHeader * 1000;
      } else if (typeof timestampHeader === 'string') {
        const num = Number(timestampHeader);
        if (!isNaN(num)) {
          tsMs = num > 1e11 ? num : num * 1000;
        } else {
          tsMs = Date.parse(timestampHeader);
        }
      }

      if (isNaN(tsMs)) {
        this.logger.warn(`[WebsiteLeads] Rejected webhook: Malformed timestamp header '${timestampHeader}' from source '${sourceId}'`);
        return { authenticated: false };
      }

      const now = Date.now();
      const drift = Math.abs(now - tsMs);
      if (drift > 300000) {
        this.logger.warn(`[WebsiteLeads] Rejected webhook: Timestamp '${timestampHeader}' out of tolerance (drift: ${drift}ms, max: 300000ms) for source '${sourceId}'`);
        return { authenticated: false };
      }
    }

    // 1. Direct shared secret verification (legacy/dev testing with replay check)
    const directSecret = headers['x-webhook-secret'] || headers['x-api-key'];
    if (directSecret && typeof directSecret === 'string') {
      try {
        const bufA = Buffer.from(directSecret);
        const bufB = Buffer.from(secret);
        if (bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)) {
          return { authenticated: true, method: 'shared_secret', timestamp: tsMs };
        }
      } catch (err) {
        // Fall through to signature check
      }
    }

    const authHeader = headers['authorization'] || headers['Authorization'];
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const bearerToken = authHeader.substring(7).trim();
      try {
        const bufA = Buffer.from(bearerToken);
        const bufB = Buffer.from(secret);
        if (bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)) {
          return { authenticated: true, method: 'shared_secret', timestamp: tsMs };
        }
      } catch (err) {
        // Fall through to signature check
      }
    }

    // 2. HMAC-SHA256 signature verification (x-hub-signature-256, x-signature-256, x-signature)
    const rawSignature = 
      headers['x-hub-signature-256'] ||
      headers['x-signature-256'] ||
      headers['x-signature'] ||
      headers['x-webhook-signature'];

    if (!rawSignature || typeof rawSignature !== 'string') {
      return { authenticated: false };
    }

    // Strip optional "sha256=" prefix
    const providedHex = rawSignature.replace(/^sha256=/i, '').trim();

    try {
      // Use exact Buffer bytes if available, avoiding JSON.stringify serialization discrepancies
      const payloadBuffer = Buffer.isBuffer(rawBody) 
        ? rawBody 
        : Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody), 'utf8');

      const providedBuf = Buffer.from(providedHex, 'hex');

      // A. Cryptographically bound HMAC with timestamp: `${timestamp}.${rawBody}`
      if (!isNaN(tsMs)) {
        const timestampedBuffer = Buffer.concat([
          Buffer.from(String(timestampHeader) + '.', 'utf8'),
          payloadBuffer,
        ]);
        const expectedHexBound = crypto
          .createHmac('sha256', secret)
          .update(timestampedBuffer)
          .digest('hex');
        const expectedBufBound = Buffer.from(expectedHexBound, 'hex');

        if (providedBuf.length === expectedBufBound.length && crypto.timingSafeEqual(providedBuf, expectedBufBound)) {
          return { authenticated: true, method: 'hmac', signatureHex: providedHex, timestamp: tsMs };
        }

        // B. Check if signature was calculated over raw body without binding the timestamp header
        const expectedHexRaw = crypto
          .createHmac('sha256', secret)
          .update(payloadBuffer)
          .digest('hex');
        const expectedBufRaw = Buffer.from(expectedHexRaw, 'hex');

        if (providedBuf.length === expectedBufRaw.length && crypto.timingSafeEqual(providedBuf, expectedBufRaw)) {
          // If strictly bound timestamps are required:
          if (headers['x-require-bound-signature'] === 'true' || process.env.REQUIRE_BOUND_TIMESTAMP === 'true') {
            this.logger.warn(`[WebsiteLeads] Rejected webhook: Timestamp header was not cryptographically bound in signature for ${sourceId}`);
            return { authenticated: false };
          }
          return { authenticated: true, method: 'hmac', signatureHex: providedHex, timestamp: tsMs };
        }

        return { authenticated: false };
      }

      // C. No timestamp header provided: verify raw body signature
      const expectedHexRaw = crypto
        .createHmac('sha256', secret)
        .update(payloadBuffer)
        .digest('hex');
      const expectedBufRaw = Buffer.from(expectedHexRaw, 'hex');

      if (providedBuf.length === expectedBufRaw.length && crypto.timingSafeEqual(providedBuf, expectedBufRaw)) {
        if (headers['x-require-timestamp'] === 'true' || process.env.REQUIRE_WEBHOOK_TIMESTAMP === 'true') {
          this.logger.warn(`[WebsiteLeads] Rejected webhook: Missing required timestamp header for ${sourceId}`);
          return { authenticated: false };
        }
        return { authenticated: true, method: 'hmac', signatureHex: providedHex };
      }

      return { authenticated: false };
    } catch (err: any) {
      this.logger.error(`[WebsiteLeads] Signature calculation error: ${err.message}`);
      return { authenticated: false };
    }
  }

  /**
   * Ingest a lead submitted via external website webhook.
   */
  public async processWebhookLead(
    sourceId: string,
    rawPayload: any,
    headers: Record<string, any>,
    rawBody?: Buffer | string,
  ): Promise<IngestionResult> {
    const config = this.registry.getSourceConfig(sourceId);
    if (!config) {
      throw new NotFoundException(`Unknown website source ID: '${sourceId}'. Must be one of registered 7 sources.`);
    }

    const validSourceId = config.sourceId;
    this.registry.recordEventReceipt(validSourceId);

    // Enforce authentication
    const bodyForAuth = rawBody || (typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload));
    const authResult = this.verifyWebhookAuthentication(validSourceId, bodyForAuth, headers);

    if (!authResult.authenticated) {
      this.registry.recordError(validSourceId, 'Unauthorized: Invalid or missing webhook signature/secret');
      throw new UnauthorizedException('Invalid or missing webhook signature/secret. Access denied.');
    }

    if (!rawPayload || typeof rawPayload !== 'object') {
      throw new BadRequestException('Malformed request: JSON object body required.');
    }

    // Strip client-supplied privileged internal fields to prevent privilege escalation
    delete rawPayload.role;
    delete rawPayload.isElevated;
    delete rawPayload.userId;
    delete rawPayload.lockedAt;
    delete rawPayload.assignedAgentId;
    delete rawPayload.uploadedById;

    // Normalize source fields to unified CRM lead structure
    const normalized = this.registry.normalize(validSourceId, rawPayload);

    if (!normalized.phoneNumber) {
      this.registry.recordError(validSourceId, 'Validation failure: missing phone number');
      throw new BadRequestException('Validation failure: A valid contact phone number is required.');
    }

    // 1. Check external submission idempotency
    // Tier 1: Check Redis primary cache
    let existingSubmissionLeadId = await this.registry.checkIdempotency(validSourceId, normalized.externalLeadId);

    // Tier 2: Check durable PostgreSQL WebsiteLeadSubmission table (eliminates reliance on note text search)
    if (!existingSubmissionLeadId && normalized.externalLeadId) {
      try {
        const dbSubmission = await (this.prisma as any).websiteLeadSubmission.findUnique({
          where: {
            sourceId_externalSubmissionId: {
              sourceId: validSourceId,
              externalSubmissionId: normalized.externalLeadId,
            },
          },
        });
        if (dbSubmission) {
          existingSubmissionLeadId = dbSubmission.leadId;
          await this.registry.recordIdempotency(validSourceId, normalized.externalLeadId, dbSubmission.leadId);
        }
      } catch (dbErr: any) {
        this.logger.warn(`[WebsiteLeads] WebsiteLeadSubmission lookup warning: ${dbErr.message}`);
      }
    }

    if (existingSubmissionLeadId) {
      this.registry.recordDuplicateSkipped(validSourceId, 1);
      return {
        success: true,
        status: 'duplicate_event',
        leadId: existingSubmissionLeadId,
        sourceId: validSourceId,
        externalLeadId: normalized.externalLeadId,
        message: 'Duplicate event recognized: Submission ID has already been ingested.',
        timestamp: new Date().toISOString(),
      };
    }

    // 2. Anti-replay verification: check if this signature was already processed in the 5-minute replay window
    if (authResult.signatureHex) {
      const isReplay = await this.registry.checkAndRecordSignature(authResult.signatureHex, 300);
      if (isReplay) {
        this.logger.warn(`[WebsiteLeads] Replay attack detected for signature: ${authResult.signatureHex.slice(0, 10)}...`);
        throw new UnauthorizedException('Replay detected: Webhook signature has already been processed within the replay window.');
      }
    }

    // Embed human-readable submission tag into notes for CRM agent reference
    const submissionTag = normalized.externalLeadId
      ? `[ExternalSubmissionId: ${validSourceId}:${normalized.externalLeadId}]`
      : '';
    const initialNotes = [submissionTag, normalized.notes].filter(Boolean).join(' ').trim() || null;

    // Atomic transaction for Lead creation/update + WebsiteLeadSubmission audit record
    try {
      const txResult = await this.prisma.$transaction(async (tx: any) => {
        // Find existing lead by phone number
        const existingLead = await tx.lead.findUnique({
          where: { phoneNumber: normalized.phoneNumber },
        });

        let targetLead: any;
        let isNewLead = false;

        if (existingLead) {
          const appendNote = `\n[${new Date().toISOString()}] Repeat enquiry from ${normalized.source}: ${normalized.notes || 'Interested in ' + (normalized.serviceInterest || 'services')}${submissionTag ? ' ' + submissionTag : ''}`;
          const updatedNotes = existingLead.notes 
            ? `${existingLead.notes}${appendNote}`
            : appendNote.trim();

          targetLead = await tx.lead.update({
            where: { id: existingLead.id },
            data: {
              notes: updatedNotes,
              serviceInterest: existingLead.serviceInterest || normalized.serviceInterest,
              city: existingLead.city || normalized.city,
            },
          });
        } else {
          targetLead = await tx.lead.create({
            data: {
              customerName: normalized.customerName || 'Unknown Lead',
              phoneNumber: normalized.phoneNumber,
              email: normalized.email || null,
              serviceInterest: normalized.serviceInterest || null,
              city: normalized.city || null,
              notes: initialNotes,
              source: normalized.source,
              status: 'NEW',
            },
          });
          isNewLead = true;
        }

        // Record external submission uniqueness in PostgreSQL
        if (normalized.externalLeadId) {
          await tx.websiteLeadSubmission.create({
            data: {
              sourceId: validSourceId,
              externalSubmissionId: normalized.externalLeadId,
              leadId: targetLead.id,
              sourceSubmittedAt: normalized.submittedAt ? new Date(normalized.submittedAt) : null,
              status: 'PROCESSED',
            },
          });
        }

        return { targetLead, isNewLead };
      });

      await this.registry.recordIdempotency(validSourceId, normalized.externalLeadId, txResult.targetLead.id);
      this.registry.recordImportSuccess(validSourceId, 1);
      this.broadcastLeadUpdate(txResult.targetLead);

      if (txResult.isNewLead) {
        return {
          success: true,
          status: 'created',
          leadId: txResult.targetLead.id,
          sourceId: validSourceId,
          externalLeadId: normalized.externalLeadId,
          message: 'New lead successfully created and assigned to pool.',
          timestamp: new Date().toISOString(),
        };
      } else {
        return {
          success: true,
          status: 'existing_lead_updated',
          leadId: txResult.targetLead.id,
          sourceId: validSourceId,
          externalLeadId: normalized.externalLeadId,
          message: 'Existing lead updated with new website enquiry details.',
          timestamp: new Date().toISOString(),
        };
      }
    } catch (err: any) {
      // Concurrency race condition: if two concurrent deliveries arrived simultaneously
      if (err.code === 'P2002') {
        // If unique constraint violation occurred on WebsiteLeadSubmission (sourceId + externalSubmissionId)
        if (normalized.externalLeadId) {
          try {
            const dbSub = await (this.prisma as any).websiteLeadSubmission.findUnique({
              where: {
                sourceId_externalSubmissionId: {
                  sourceId: validSourceId,
                  externalSubmissionId: normalized.externalLeadId,
                },
              },
            });
            if (dbSub) {
              await this.registry.recordIdempotency(validSourceId, normalized.externalLeadId, dbSub.leadId);
              this.registry.recordDuplicateSkipped(validSourceId, 1);
              return {
                success: true,
                status: 'duplicate_event',
                leadId: dbSub.leadId,
                sourceId: validSourceId,
                externalLeadId: normalized.externalLeadId,
                message: 'Duplicate event recognized: Submission ID has already been ingested.',
                timestamp: new Date().toISOString(),
              };
            }
          } catch (_) {}
        }

        // If unique constraint violation occurred on Lead.phoneNumber concurrency race
        const raceExisting = await this.prisma.lead.findUnique({
          where: { phoneNumber: normalized.phoneNumber },
        });

        if (raceExisting) {
          const appendNote = `\n[${new Date().toISOString()}] Repeat enquiry from ${normalized.source}: ${normalized.notes || 'Interested in ' + (normalized.serviceInterest || 'services')}${submissionTag ? ' ' + submissionTag : ''}`;
          const updatedNotes = raceExisting.notes 
            ? `${raceExisting.notes}${appendNote}`
            : appendNote.trim();

          const updated = await this.prisma.lead.update({
            where: { id: raceExisting.id },
            data: {
              notes: updatedNotes,
              serviceInterest: raceExisting.serviceInterest || normalized.serviceInterest,
              city: raceExisting.city || normalized.city,
            },
          });

          if (normalized.externalLeadId) {
            try {
              await (this.prisma as any).websiteLeadSubmission.create({
                data: {
                  sourceId: validSourceId,
                  externalSubmissionId: normalized.externalLeadId,
                  leadId: raceExisting.id,
                  sourceSubmittedAt: normalized.submittedAt ? new Date(normalized.submittedAt) : null,
                  status: 'PROCESSED',
                },
              });
            } catch (_) {}
          }

          await this.registry.recordIdempotency(validSourceId, normalized.externalLeadId, raceExisting.id);
          this.registry.recordImportSuccess(validSourceId, 1);
          this.broadcastLeadUpdate(updated);

          return {
            success: true,
            status: 'existing_lead_updated',
            leadId: raceExisting.id,
            sourceId: validSourceId,
            externalLeadId: normalized.externalLeadId,
            message: 'Existing lead updated with new website enquiry details.',
            timestamp: new Date().toISOString(),
          };
        }
      }
      throw err;
    }
  }

  /**
   * Import historical leads from export/array with dry-run support,
   * safe checkpoint resumption, and interruption tolerance.
   */
  public async syncHistoricalLeads(
    sourceId: string,
    records: Array<any>,
    options: HistoricalImportOptions = {},
  ): Promise<HistoricalImportResult> {
    const config = this.registry.getSourceConfig(sourceId);
    if (!config) {
      throw new NotFoundException(`Unknown website source ID: '${sourceId}'`);
    }

    const validSourceId = config.sourceId;
    const isDryRun = !!options.dryRun;
    const totalProvided = Array.isArray(records) ? records.length : 0;

    const result: HistoricalImportResult = {
      success: true,
      dryRun: isDryRun,
      sourceId: validSourceId,
      totalProvided,
      validRecords: 0,
      invalidRecords: 0,
      duplicatesSkipped: 0,
      createdCount: 0,
      updatedCount: 0,
      checkpointCursor: null,
      errors: [],
      sampleMapped: [],
    };

    if (!Array.isArray(records) || records.length === 0) {
      return result;
    }

    const seenPhonesInBatch = new Set<string>();

    // Determine start index from checkpoint cursor
    let startIndex = 0;
    if (options.checkpoint) {
      if (options.checkpoint.startsWith('index:')) {
        const parsedIdx = parseInt(options.checkpoint.slice(6), 10);
        if (!isNaN(parsedIdx)) {
          startIndex = parsedIdx + 1;
        }
      } else {
        const matchIdx = records.findIndex(r => (r.externalLeadId || r.id) === options.checkpoint);
        if (matchIdx >= 0) {
          startIndex = matchIdx + 1;
        }
      }
    }

    let lastSuccessfulIndex = startIndex > 0 ? startIndex - 1 : -1;

    for (let i = startIndex; i < records.length; i++) {
      // Simulate interruption if requested for resilience validation
      if (options.simulateInterruptionAtIndex !== undefined && i === options.simulateInterruptionAtIndex) {
        this.logger.warn(`[WebsiteLeads] Simulated import interruption at index ${i}`);
        if (!isDryRun && lastSuccessfulIndex >= 0) {
          await this.registry.updateCheckpoint(validSourceId, `index:${lastSuccessfulIndex}`);
        }
        result.checkpointCursor = lastSuccessfulIndex >= 0 ? `index:${lastSuccessfulIndex}` : null;
        result.success = false;
        result.errors.push({ index: i, error: `Batch import simulated interruption at index ${i}` });
        return result;
      }

      const raw = records[i];
      try {
        const normalized = this.registry.normalize(validSourceId, raw);
        if (!normalized.phoneNumber) {
          result.invalidRecords += 1;
          result.errors.push({ index: i, error: 'Missing contact phone number' });
          continue;
        }

        result.validRecords += 1;

        if (i < 5) {
          result.sampleMapped?.push(normalized);
        }

        if (seenPhonesInBatch.has(normalized.phoneNumber)) {
          result.duplicatesSkipped += 1;
          continue;
        }
        seenPhonesInBatch.add(normalized.phoneNumber);

        // Format historical submission timestamp into notes preserving CRM record createdAt
        const submissionTimestampNote = normalized.submittedAt
          ? `[Original Website Submission: ${normalized.submittedAt}]`
          : '';
        const submissionTag = normalized.externalLeadId
          ? `[ExternalSubmissionId: ${validSourceId}:${normalized.externalLeadId}]`
          : '';
        const combinedNotes = [submissionTag, submissionTimestampNote, normalized.notes]
          .filter(Boolean)
          .join(' ')
          .trim() || null;

        // Check if externalLeadId has already been imported
        if (normalized.externalLeadId) {
          try {
            const dbExistingSub = await (this.prisma as any).websiteLeadSubmission.findUnique({
              where: {
                sourceId_externalSubmissionId: {
                  sourceId: validSourceId,
                  externalSubmissionId: normalized.externalLeadId,
                },
              },
            });
            if (dbExistingSub) {
              result.duplicatesSkipped += 1;
              lastSuccessfulIndex = i;
              continue;
            }
          } catch (_) {}
        }

        if (!isDryRun) {
          await this.prisma.$transaction(async (tx: any) => {
            const existing = await tx.lead.findUnique({
              where: { phoneNumber: normalized.phoneNumber },
            });

            let targetLeadId: string;
            if (existing) {
              await tx.lead.update({
                where: { id: existing.id },
                data: {
                  notes: existing.notes ? `${existing.notes}\n[Historical Import] ${combinedNotes || ''}` : combinedNotes,
                  serviceInterest: existing.serviceInterest || normalized.serviceInterest,
                },
              });
              targetLeadId = existing.id;
              result.updatedCount += 1;
            } else {
              const created = await tx.lead.create({
                data: {
                  customerName: normalized.customerName,
                  phoneNumber: normalized.phoneNumber,
                  email: normalized.email,
                  serviceInterest: normalized.serviceInterest,
                  city: normalized.city,
                  notes: combinedNotes,
                  source: normalized.source,
                  status: 'NEW',
                },
              });
              targetLeadId = created.id;
              result.createdCount += 1;
            }

            if (normalized.externalLeadId) {
              await tx.websiteLeadSubmission.create({
                data: {
                  sourceId: validSourceId,
                  externalSubmissionId: normalized.externalLeadId,
                  leadId: targetLeadId,
                  sourceSubmittedAt: normalized.submittedAt ? new Date(normalized.submittedAt) : null,
                  status: 'HISTORICAL_IMPORT',
                },
              });
            }
          });
          lastSuccessfulIndex = i;
          await this.registry.updateCheckpoint(validSourceId, `index:${i}`);
        }
      } catch (err: any) {
        result.invalidRecords += 1;
        result.errors.push({ index: i, error: err.message });
      }
    }

    result.attemptedCount = Math.min(totalProvided, lastSuccessfulIndex + 1);
    result.remainingCount = Math.max(0, totalProvided - (lastSuccessfulIndex + 1));

    if (!isDryRun) {
      this.registry.recordImportSuccess(validSourceId, result.createdCount + result.updatedCount);
      this.registry.recordDuplicateSkipped(validSourceId, result.duplicatesSkipped);
      result.checkpointCursor = lastSuccessfulIndex >= 0 ? `index:${lastSuccessfulIndex}` : null;
    }
    return result;
  }

  public getSourceStatuses(): SourceSyncStatus[] {
    return this.registry.getAllSourceStatuses();
  }

  public async testSourcePing(sourceId: string, simulateLead = false): Promise<any> {
    const config = this.registry.getSourceConfig(sourceId);
    if (!config) {
      throw new NotFoundException(`Unknown website source ID: '${sourceId}'`);
    }

    const secret = this.registry.getSourceSecret(config.sourceId);
    const isConfigured = !!secret;

    if (!simulateLead) {
      return {
        success: true,
        sourceId: config.sourceId,
        websiteUrl: config.websiteUrl,
        configured: isConfigured,
        adapterType: config.adapterType,
        message: 'Handshake verification successful. Source adapter is ready to receive webhooks.',
        timestamp: new Date().toISOString(),
      };
    }

    // Controlled test event
    const testPayload = {
      name: `Test Ping ${config.sourceId}`,
      phone: `+9199999${Math.floor(10000 + Math.random() * 90000)}`,
      email: `test-${config.sourceId}@paramantra.com`,
      message: 'Automated connectivity test from CRM integration suite',
      externalLeadId: `test_ping_${Date.now()}`,
    };

    const headers = {
      'x-webhook-secret': secret,
    };

    return await this.processWebhookLead(config.sourceId, testPayload, headers);
  }

  private broadcastLeadUpdate(lead: any) {
    try {
      if (this.telephonyGateway?.server) {
        this.telephonyGateway.server.emit('leadsUpdated', lead);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to broadcast leadsUpdated event: ${err.message}`);
    }
  }
}
