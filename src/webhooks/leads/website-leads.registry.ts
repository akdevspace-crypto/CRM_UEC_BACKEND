import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { WebsiteSourceConfig, WebsiteSourceId, NormalizedLeadPayload, SourceSyncStatus } from './website-leads.types';

@Injectable()
export class WebsiteLeadsRegistry {
  private readonly logger = new Logger(WebsiteLeadsRegistry.name);

  // Configuration registry for all seven websites
  private readonly sources: Map<WebsiteSourceId, WebsiteSourceConfig> = new Map([
    [
      'anbu-sri-sai',
      {
        sourceId: 'anbu-sri-sai',
        name: 'Anbu Sri Sai Home Health Care',
        websiteUrl: 'https://www.anbusrisaihomenursing.com',
        envSecretKey: 'LEAD_WEBHOOK_SECRET_ANBU_SRI_SAI',
        defaultSecret: 'sec_anbu_sri_sai_eldercare_2026',
        defaultServiceInterest: 'Home Nursing Care',
        sourceLabel: 'Website: anbusrisaihomenursing.com',
        adapterType: 'custom_php_form',
      },
    ],
    [
      'thathapatti',
      {
        sourceId: 'thathapatti',
        name: 'Thatha Patti Elders Care Foundation',
        websiteUrl: 'https://www.thathapatti.com',
        envSecretKey: 'LEAD_WEBHOOK_SECRET_THATHAPATTI',
        defaultSecret: 'sec_thathapatti_eldercare_2026',
        defaultServiceInterest: 'Elder Care',
        sourceLabel: 'Website: thathapatti.com',
        adapterType: 'custom_php_form',
      },
    ],
    [
      'thathapatti-homecare',
      {
        sourceId: 'thathapatti-homecare',
        name: 'Thatha Patti Home Health Care',
        websiteUrl: 'https://homecare.thathapatti.com',
        envSecretKey: 'LEAD_WEBHOOK_SECRET_THATHAPATTI_HOMECARE',
        defaultSecret: 'sec_thathapatti_homecare_2026',
        defaultServiceInterest: 'Home Care Services',
        sourceLabel: 'Website: homecare.thathapatti.com',
        adapterType: 'custom_php_form',
      },
    ],
    [
      'uncf-trust',
      {
        sourceId: 'uncf-trust',
        name: 'Universal Nature Care & Cure Foundation (UNCF Trust)',
        websiteUrl: 'https://www.uncftrust.org',
        envSecretKey: 'LEAD_WEBHOOK_SECRET_UNCF_TRUST',
        defaultSecret: 'sec_uncf_trust_eldercare_2026',
        defaultServiceInterest: 'Geriatric & Social Care',
        sourceLabel: 'Website: uncftrust.org',
        adapterType: 'custom_php_form',
      },
    ],
    [
      'universal-eldercare',
      {
        sourceId: 'universal-eldercare',
        name: 'Universal Elder Care',
        websiteUrl: 'https://www.universaleldercare.com',
        envSecretKey: 'LEAD_WEBHOOK_SECRET_UNIVERSAL_ELDERCARE',
        defaultSecret: 'sec_universal_eldercare_2026',
        defaultServiceInterest: 'Elder Care & Support',
        sourceLabel: 'Website: universaleldercare.com',
        adapterType: 'landing_page_enquiry',
      },
    ],
    [
      'zencura',
      {
        sourceId: 'zencura',
        name: 'Zencura Global Wellness',
        websiteUrl: 'https://www.zencura.org',
        envSecretKey: 'LEAD_WEBHOOK_SECRET_ZENCURA',
        defaultSecret: 'sec_zencura_eldercare_2026',
        defaultServiceInterest: 'Global Wellness & Integrative Care',
        sourceLabel: 'Website: zencura.org',
        adapterType: 'landing_page_enquiry',
      },
    ],
    [
      'bytezcorp',
      {
        sourceId: 'bytezcorp',
        name: 'Bytez Corp Technologies',
        websiteUrl: 'https://www.bytezcorp.com',
        envSecretKey: 'LEAD_WEBHOOK_SECRET_BYTEZCORP',
        defaultSecret: 'sec_bytezcorp_eldercare_2026',
        defaultServiceInterest: 'Digital Solutions & Consulting',
        sourceLabel: 'Website: bytezcorp.com',
        adapterType: 'landing_page_enquiry',
      },
    ],
  ]);

  // Operational metrics and sync checkpoints per source
  private readonly sourceStatuses: Map<WebsiteSourceId, SourceSyncStatus> = new Map();

  // In-memory fallback idempotency store for external submission IDs: key -> { leadId, timestamp }
  private readonly idempotencyStore: Map<string, { leadId: string; timestamp: number }> = new Map();

  // In-memory fallback store for signature nonces: signature -> timestamp
  private readonly signatureStore: Map<string, number> = new Map();

  constructor(@Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis) {
    this.initSourceStatuses();
  }

  private initSourceStatuses() {
    for (const [sourceId, config] of this.sources.entries()) {
      this.sourceStatuses.set(sourceId, {
        sourceId,
        name: config.name,
        websiteUrl: config.websiteUrl,
        sourceLabel: config.sourceLabel,
        enabled: true,
        configured: true,
        adapterType: config.adapterType,
        totalReceived: 0,
        recordsImported: 0,
        duplicatesSkipped: 0,
        lastReceivedAt: null,
        lastSyncAt: null,
        lastSuccessAt: null,
        lastError: null,
        checkpointCursor: null,
      });
    }
  }

  public getAllSources(): WebsiteSourceConfig[] {
    return Array.from(this.sources.values());
  }

  public getSourceConfig(sourceId: string): WebsiteSourceConfig | null {
    return this.sources.get(sourceId as WebsiteSourceId) || null;
  }

  public getSourceSecret(sourceId: WebsiteSourceId): string {
    const config = this.sources.get(sourceId);
    if (!config) return '';
    const envSecret = process.env[config.envSecretKey];
    
    // In strict production, never fall back to development defaults
    if (process.env.NODE_ENV === 'production') {
      if (!envSecret) {
        this.logger.error(`[WebsiteLeads] Production configuration error: Missing required environment secret '${config.envSecretKey}' for source '${sourceId}'`);
        return '';
      }
      return envSecret;
    }

    return envSecret || config.defaultSecret;
  }

  public getSourceStatus(sourceId: WebsiteSourceId): SourceSyncStatus | null {
    return this.sourceStatuses.get(sourceId) || null;
  }

  public getAllSourceStatuses(): SourceSyncStatus[] {
    return Array.from(this.sourceStatuses.values());
  }

  public recordEventReceipt(sourceId: WebsiteSourceId) {
    const status = this.sourceStatuses.get(sourceId);
    if (status) {
      status.totalReceived += 1;
      status.lastReceivedAt = new Date().toISOString();
    }
  }

  public recordImportSuccess(sourceId: WebsiteSourceId, count = 1) {
    const status = this.sourceStatuses.get(sourceId);
    if (status) {
      status.recordsImported += count;
      status.lastSuccessAt = new Date().toISOString();
      status.lastError = null;
    }
  }

  public recordDuplicateSkipped(sourceId: WebsiteSourceId, count = 1) {
    const status = this.sourceStatuses.get(sourceId);
    if (status) {
      status.duplicatesSkipped += count;
    }
  }

  public recordError(sourceId: WebsiteSourceId, errorMessage: string) {
    const status = this.sourceStatuses.get(sourceId);
    if (status) {
      status.lastError = errorMessage;
    }
  }

  public async updateCheckpoint(sourceId: WebsiteSourceId, cursor: string) {
    const nowIso = new Date().toISOString();
    const status = this.sourceStatuses.get(sourceId);
    if (status) {
      status.checkpointCursor = cursor;
      status.lastSyncAt = nowIso;
    }

    if (this.redis) {
      try {
        await this.redis.hset(
          'website_lead_checkpoints',
          sourceId,
          JSON.stringify({ cursor, lastSyncAt: nowIso }),
        );
      } catch (err: any) {
        this.logger.warn(`Failed to persist checkpoint to Redis for ${sourceId}: ${err.message}`);
      }
    }
  }

  public async getCheckpoint(sourceId: WebsiteSourceId): Promise<string | null> {
    if (this.redis) {
      try {
        const val = await this.redis.hget('website_lead_checkpoints', sourceId);
        if (val) {
          const parsed = JSON.parse(val);
          return parsed.cursor || null;
        }
      } catch (err: any) {
        this.logger.warn(`Failed to retrieve checkpoint from Redis for ${sourceId}: ${err.message}`);
      }
    }
    return this.sourceStatuses.get(sourceId)?.checkpointCursor || null;
  }

  /**
   * Anti-replay signature tracking.
   * Atomically records signature with TTL (default 300s = 5 min).
   * Returns true if signature was ALREADY seen (replay detected), false otherwise.
   */
  public async checkAndRecordSignature(signatureHex: string, ttlSeconds = 300): Promise<boolean> {
    if (!signatureHex) return false;
    const key = `lead:sig:${signatureHex}`;

    if (this.redis) {
      try {
        // Atomic SET key 1 EX ttlSeconds NX
        const result = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
        // result is 'OK' if newly set, null if already existed (replayed!)
        return result === null;
      } catch (err: any) {
        this.logger.warn(`Redis checkAndRecordSignature error for ${key}: ${err.message}`);
      }
    }

    // In-memory fallback
    const now = Date.now();
    const existingTimestamp = this.signatureStore.get(key);
    if (existingTimestamp && (now - existingTimestamp) < (ttlSeconds * 1000)) {
      return true; // Replay detected
    }
    this.signatureStore.set(key, now);

    if (this.signatureStore.size > 50000) {
      const firstKey = this.signatureStore.keys().next().value;
      if (firstKey) this.signatureStore.delete(firstKey);
    }

    return false;
  }

  // Durable Idempotency helpers (backed by Redis with in-memory fallback)
  public async checkIdempotency(
    sourceId: WebsiteSourceId,
    externalLeadId: string | null,
    onRedisError: 'fail_closed' | 'fallback' = 'fallback',
  ): Promise<string | null> {
    if (!externalLeadId) return null;
    const key = `lead:idemp:${sourceId}:${externalLeadId}`;

    if (this.redis) {
      try {
        const cachedLeadId = await this.redis.get(key);
        if (cachedLeadId) {
          return cachedLeadId;
        }
      } catch (err: any) {
        this.logger.error(`Redis get idempotency error for ${key}: ${err.message}`);
        if (onRedisError === 'fail_closed') {
          throw err;
        }
      }
    }

    const localRecord = this.idempotencyStore.get(key);
    if (localRecord) {
      return localRecord.leadId;
    }
    return null;
  }

  public async recordIdempotency(sourceId: WebsiteSourceId, externalLeadId: string | null, leadId: string): Promise<void> {
    if (!externalLeadId) return;
    const key = `lead:idemp:${sourceId}:${externalLeadId}`;

    if (this.redis) {
      try {
        // Store with 7-day TTL (604,800 seconds)
        await this.redis.set(key, leadId, 'EX', 604800);
      } catch (err: any) {
        this.logger.warn(`Redis set idempotency failed for ${key}: ${err.message}`);
      }
    }

    this.idempotencyStore.set(key, { leadId, timestamp: Date.now() });

    // Prevent memory leaks in fallback map
    if (this.idempotencyStore.size > 50000) {
      const firstKey = this.idempotencyStore.keys().next().value;
      if (firstKey) this.idempotencyStore.delete(firstKey);
    }
  }

  // ==============================================================
  // SOURCE-SPECIFIC NORMALIZATION ADAPTERS
  // ==============================================================

  public normalize(sourceId: WebsiteSourceId, raw: any): NormalizedLeadPayload {
    switch (sourceId) {
      case 'anbu-sri-sai':
        return this.normalizeAnbuSriSai(raw);
      case 'thathapatti':
        return this.normalizeThathapatti(raw);
      case 'thathapatti-homecare':
        return this.normalizeThathapattiHomecare(raw);
      case 'uncf-trust':
        return this.normalizeUncfTrust(raw);
      case 'universal-eldercare':
        return this.normalizeUniversalEldercare(raw);
      case 'zencura':
        return this.normalizeZencura(raw);
      case 'bytezcorp':
        return this.normalizeBytezcorp(raw);
      default:
        return this.normalizeGeneric(raw, sourceId);
    }
  }

  private cleanPhone(phone: any): string {
    if (!phone) return '';
    let cleaned = String(phone).replace(/[^\d+]/g, '').trim();
    if (cleaned.startsWith('0') && cleaned.length === 11) {
      cleaned = cleaned.substring(1);
    }
    if (/^\d{10}$/.test(cleaned)) {
      cleaned = `+91${cleaned}`;
    } else if (/^91\d{10}$/.test(cleaned)) {
      cleaned = `+${cleaned}`;
    } else if (/^\d{11,15}$/.test(cleaned) && !cleaned.startsWith('+')) {
      cleaned = `+${cleaned}`;
    }
    return cleaned;
  }

  private cleanExternalId(raw: any): string | null {
    if (!raw) return null;
    const val = 
      raw.externalLeadId || 
      raw.externalSubmissionId || 
      raw.submissionId || 
      raw.submission_id || 
      raw.enquiryId || 
      raw.bookingId || 
      raw.id || 
      null;
    return val ? String(val).trim() : null;
  }

  // 1. Anbu Sri Sai Adapter (anbusrisaihomenursing.com)
  private normalizeAnbuSriSai(raw: any): NormalizedLeadPayload {
    const fname = raw.fname || raw.firstName || '';
    const lname = raw.lname || raw.lastName || '';
    const fullName = `${fname} ${lname}`.trim();
    const customerName = fullName || raw.name || raw.customerName || 'Unknown Lead';

    const phoneNumber = this.cleanPhone(raw.phone || raw.phoneNumber || raw.mobile);
    const email = raw.email ? String(raw.email).trim().toLowerCase() : null;
    const serviceInterest = raw.service || raw.serviceInterest || 'Home Nursing Care';
    const city = raw.city || 'Coimbatore';

    let notes = raw.message || raw.notes || raw.enquiry || '';
    if (raw.preferredShift) notes = `[Shift: ${raw.preferredShift}] ${notes}`.trim();

    const externalLeadId = this.cleanExternalId(raw);

    return {
      customerName,
      phoneNumber,
      email,
      serviceInterest,
      city,
      notes: notes || null,
      source: 'Website: anbusrisaihomenursing.com',
      externalLeadId,
      formLocation: raw.form_location || 'home-care-contact',
      submittedAt: raw.submittedAt || raw.createdAt || new Date().toISOString(),
    };
  }

  // 2. Thatha Patti Elders Care Foundation (thathapatti.com)
  private normalizeThathapatti(raw: any): NormalizedLeadPayload {
    const customerName = raw.name || raw.customerName || raw.fullName || 'Unknown Lead';
    const phoneNumber = this.cleanPhone(raw.phone || raw.phoneNumber || raw.whatsapp || raw.mobile);
    const email = raw.email ? String(raw.email).trim().toLowerCase() : null;

    // Service dropdown code translation
    const serviceMap: Record<string, string> = {
      '18': 'Aging Care',
      '14': 'Assisted Living',
      '15': 'Bedridden Care',
      '17': 'Dementia Care',
      '46': 'Home Health Care Service',
      '12': 'Home Nursing Service',
      '45': 'Physio Rehabilitation Care',
      '16': 'Post-Operative Care',
    };
    const rawService = String(raw.service || raw.serviceInterest || '').trim();
    const serviceInterest = serviceMap[rawService] || rawService || 'Elder Care';

    const formLocation = raw.form_location || 'online-booking';
    let notes = raw.notes || raw.message || raw.enquiry || '';
    if (formLocation) {
      notes = `[Form: ${formLocation}] ${notes}`.trim();
    }

    const externalLeadId = this.cleanExternalId(raw);

    return {
      customerName,
      phoneNumber,
      email,
      serviceInterest,
      city: raw.city || 'Coimbatore',
      notes: notes || null,
      source: 'Website: thathapatti.com',
      externalLeadId,
      formLocation,
      submittedAt: raw.submittedAt || raw.createdAt || new Date().toISOString(),
    };
  }

  // 3. Thatha Patti Home Health Care (homecare.thathapatti.com)
  private normalizeThathapattiHomecare(raw: any): NormalizedLeadPayload {
    const customerName = raw.name || raw.customerName || raw.fullName || 'Unknown Lead';
    const phoneNumber = this.cleanPhone(raw.phone || raw.phoneNumber || raw.mobile);
    const email = raw.email ? String(raw.email).trim().toLowerCase() : null;

    const serviceMap: Record<string, string> = {
      '28': 'Ageing Care Services',
      '10': 'Home Visit Nurse',
      '11': 'Home Visit Doctor',
      '12': 'Home Nursing Service',
      '14': 'Assisted Living',
      '15': 'Bedridden Care',
      '16': 'Post Surgery Care',
      '17': 'Dementia Care',
    };
    const rawService = String(raw.service || raw.serviceInterest || '').trim();
    const serviceInterest = serviceMap[rawService] || rawService || 'Home Care Services';

    const formLocation = raw.form_location || 'homecare-index';
    let notes = raw.notes || raw.message || '';
    if (formLocation) {
      notes = `[Location: ${formLocation}] ${notes}`.trim();
    }

    const externalLeadId = this.cleanExternalId(raw);

    return {
      customerName,
      phoneNumber,
      email,
      serviceInterest,
      city: raw.city || 'Coimbatore',
      notes: notes || null,
      source: 'Website: homecare.thathapatti.com',
      externalLeadId,
      formLocation,
      submittedAt: raw.submittedAt || raw.createdAt || new Date().toISOString(),
    };
  }

  // 4. UNCF Trust (uncftrust.org)
  private normalizeUncfTrust(raw: any): NormalizedLeadPayload {
    const customerName = raw.name || raw.customerName || 'Unknown Lead';
    const phoneNumber = this.cleanPhone(raw.phone || raw.phoneNumber || raw.mobile);
    const email = raw.email ? String(raw.email).trim().toLowerCase() : null;
    const subject = raw.subject || raw.service || 'Geriatric & Social Care';

    let notes = raw.message || raw.notes || '';
    if (subject) {
      notes = `[Subject: ${subject}] ${notes}`.trim();
    }

    const externalLeadId = this.cleanExternalId(raw);

    return {
      customerName,
      phoneNumber,
      email,
      serviceInterest: subject,
      city: raw.city || 'Coimbatore',
      notes: notes || null,
      source: 'Website: uncftrust.org',
      externalLeadId,
      formLocation: raw.formLocation || 'contact-form',
      submittedAt: raw.submittedAt || raw.createdAt || new Date().toISOString(),
    };
  }

  // 5. Universal Elder Care (universaleldercare.com)
  private normalizeUniversalEldercare(raw: any): NormalizedLeadPayload {
    const customerName = raw.name || raw.fullName || raw.customerName || 'Unknown Lead';
    const phoneNumber = this.cleanPhone(raw.phone || raw.phoneNumber || raw.mobile);
    const email = raw.email ? String(raw.email).trim().toLowerCase() : null;
    const serviceInterest = raw.service || raw.serviceInterest || 'Elder Care & Support';
    const notes = raw.message || raw.notes || raw.enquiry || null;
    const externalLeadId = this.cleanExternalId(raw);

    return {
      customerName,
      phoneNumber,
      email,
      serviceInterest,
      city: raw.city || 'Coimbatore',
      notes,
      source: 'Website: universaleldercare.com',
      externalLeadId,
      formLocation: raw.formLocation || 'website-enquiry',
      submittedAt: raw.submittedAt || raw.createdAt || new Date().toISOString(),
    };
  }

  // 6. Zencura (zencura.org)
  private normalizeZencura(raw: any): NormalizedLeadPayload {
    const customerName = raw.name || raw.fullName || 'Unknown Lead';
    const phoneNumber = this.cleanPhone(raw.phone || raw.phoneNumber || raw.mobile);
    const email = raw.email ? String(raw.email).trim().toLowerCase() : null;
    const serviceInterest = raw.interest || raw.service || 'Global Wellness & Integrative Care';
    const notes = raw.message || raw.notes || raw.wellnessGoals || null;
    const externalLeadId = this.cleanExternalId(raw);

    return {
      customerName,
      phoneNumber,
      email,
      serviceInterest,
      city: raw.city || null,
      notes,
      source: 'Website: zencura.org',
      externalLeadId,
      formLocation: raw.formLocation || 'prelaunch-signup',
      submittedAt: raw.submittedAt || raw.createdAt || new Date().toISOString(),
    };
  }

  // 7. Bytez Corp (bytezcorp.com)
  private normalizeBytezcorp(raw: any): NormalizedLeadPayload {
    const customerName = raw.name || raw.fullName || 'Unknown Lead';
    const phoneNumber = this.cleanPhone(raw.phone || raw.phoneNumber || raw.mobile);
    const email = raw.email ? String(raw.email).trim().toLowerCase() : null;
    const serviceInterest = raw.service || raw.serviceInterest || 'Digital Solutions & Consulting';

    let notes = raw.message || raw.notes || '';
    if (raw.company) {
      notes = `[Company: ${raw.company}] ${notes}`.trim();
    }

    const externalLeadId = this.cleanExternalId(raw);

    return {
      customerName,
      phoneNumber,
      email,
      serviceInterest,
      city: raw.city || 'Coimbatore',
      notes: notes || null,
      source: 'Website: bytezcorp.com',
      externalLeadId,
      formLocation: raw.formLocation || 'contact-agency',
      submittedAt: raw.submittedAt || raw.createdAt || new Date().toISOString(),
    };
  }

  private normalizeGeneric(raw: any, sourceId: string): NormalizedLeadPayload {
    const customerName = raw.customerName || raw.name || raw.fullName || 'Unknown Lead';
    const phoneNumber = this.cleanPhone(raw.phoneNumber || raw.phone || raw.mobile);
    const email = raw.email ? String(raw.email).trim().toLowerCase() : null;
    const serviceInterest = raw.serviceInterest || raw.service || 'General Enquiry';
    const notes = raw.notes || raw.message || null;
    const externalLeadId = this.cleanExternalId(raw);

    return {
      customerName,
      phoneNumber,
      email,
      serviceInterest,
      city: raw.city || null,
      notes,
      source: `Website: ${sourceId}`,
      externalLeadId,
      formLocation: raw.formLocation || 'generic',
      submittedAt: raw.submittedAt || raw.createdAt || new Date().toISOString(),
    };
  }
}
