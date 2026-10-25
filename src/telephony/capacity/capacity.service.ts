import { Injectable, Logger, Inject, Optional, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Redis } from 'ioredis';

export type CapacityPolicyMode = 'UNLIMITED_APPLICATION' | 'CONFIGURED' | 'PROVIDER_MANAGED';
export type InboundPriorityPolicy = 'FAVOR_INBOUND_LAST_CHANNEL' | 'EQUAL_SHARED_POOL';

export interface TelephonyCapacityConfig {
  provider: string;
  mode: CapacityPolicyMode;
  totalChannels: number;
  inboundReserved: number;
  maxOutboundChannels: number;
  inboundPriorityPolicy: InboundPriorityPolicy;
  favorInboundOnLastChannel: boolean;
  protectInboundEmergencies: boolean;
  providerCpsLimit: number; // Max call setups per second
  isThrottlingOutbound: boolean;
  autoReconcileIntervalSeconds: number;
  sourceDescription?: string;
  providerLimit?: number;
}

export interface CapacityReservationResult {
  success: boolean;
  reason?: string;
  allocatedChannels?: number;
  reservationToken?: string;
  currentUsage?: {
    totalActive: number;
    inboundActive: number;
    outboundActive: number;
    availableChannels: number;
  };
}

export interface CapacityStatus {
  provider: string;
  mode: CapacityPolicyMode;
  totalChannels: number;
  effectiveCapacity: number;
  providerLimit: number;
  inboundReserved: number;
  maxOutboundChannels: number;
  activeInbound: number;
  activeOutbound: number;
  activeHeld: number;
  totalActive: number;
  pendingReservations: number;
  occupiedChannels: number;
  availableChannels: number | null;
  isThrottled: boolean;
  utilizationPercent: number | null;
  freshnessTimestamp: Date;
  isVerifiedRealtime: boolean;
  protectInboundEmergencies: boolean;
  providerCpsLimit: number;
  sourceDescription: string;
  inboundPriorityPolicy: InboundPriorityPolicy;
  favorInboundOnLastChannel: boolean;
  providerSource: string;
  reconciliationStatus: string;
  staleReservationCount: number;
}

@Injectable()
export class CapacityService implements OnModuleInit {
  private readonly logger = new Logger(CapacityService.name);

  // In-memory fallback if Redis is temporarily unreachable
  private localCounters = new Map<string, { totalActive: number; inboundActive: number; outboundActive: number }>();
  private localReservations = new Map<string, { provider: string; direction: string; channels: number; reservedAt: number; token: string }>();
  private recentDials: number[] = [];

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing Global Telephony Capacity Orchestrator (Phase 20 Dynamic Architecture)...');
    await this.syncCapacityConfig('vobiz');
    await this.reconcileStaleReservations('vobiz').catch((err) => {
      this.logger.warn(`[CAPACITY-INIT-RECONCILE] Non-fatal init reconcile warning: ${err.message}`);
    });
  }

  /**
   * Retrieves runtime capacity configuration following strict precedence:
   * 1. Authoritative DB IntegrationConfiguration (Administrator Policy)
   * 2. Provider-reported contracted limits (VOBIZ_CHANNEL_CAPACITY, default 3)
   * 3. Environment Variables (TELEPHONY_TOTAL_CHANNELS, TELEPHONY_INBOUND_RESERVED, etc.)
   * 4. Default: Shared Pool of 3 Concurrent Channels (Inbound + Outbound Combined)
   *
   * Precedence Rule: Stale environment variables or database records with maxOutboundChannels: 1
   * cannot silently restrict outbound calls under the shared 3-channel architecture.
   */
  /**
   * Retrieves runtime capacity configuration following strict precedence:
   * 1. Authoritative DB IntegrationConfiguration (Administrator Policy)
   * 2. Provider-reported contracted limits (VOBIZ_CHANNEL_CAPACITY, default 3)
   * 3. Environment Variables (TELEPHONY_TOTAL_CHANNELS, TELEPHONY_INBOUND_RESERVED, etc.)
   * 4. Default: Shared Pool of 3 Concurrent Channels (Inbound + Outbound Combined)
   *
   * Precedence Rule: Stale environment variables or database records with maxOutboundChannels: 1
   * cannot silently restrict outbound calls under the shared 3-channel architecture.
   */
  async getCapacityConfig(provider = 'vobiz'): Promise<TelephonyCapacityConfig> {
    const rawMode = process.env.TELEPHONY_CAPACITY_MODE?.toUpperCase() as CapacityPolicyMode | undefined;
    const explicitEnvTotal = process.env.TELEPHONY_TOTAL_CHANNELS ? parseInt(process.env.TELEPHONY_TOTAL_CHANNELS, 10) : null;
    const explicitEnvInbound = process.env.TELEPHONY_INBOUND_RESERVED ? parseInt(process.env.TELEPHONY_INBOUND_RESERVED, 10) : null;
    const providerAccountLimit = parseInt(process.env.VOBIZ_CHANNEL_CAPACITY || '3', 10);

    // Phase 23: Default to 3 shared concurrent channels
    let defaultMode: CapacityPolicyMode = 'CONFIGURED';
    let defaultTotal = explicitEnvTotal !== null && explicitEnvTotal > 0 ? explicitEnvTotal : 3;
    let defaultInbound = explicitEnvInbound !== null ? explicitEnvInbound : 0;
    let defaultMaxOutbound = defaultTotal; // Full shared pool available for outbound
    let defaultFavorLast = defaultInbound > 0;
    let sourceDesc = `Shared Pool (${defaultTotal} channels) - Provider Limit: ${providerAccountLimit}`;

    if (rawMode === 'UNLIMITED_APPLICATION') {
      defaultMode = 'UNLIMITED_APPLICATION';
      defaultTotal = explicitEnvTotal || 3;
      defaultInbound = 0;
      defaultMaxOutbound = 0;
      defaultFavorLast = false;
      sourceDesc = 'Environment: Unconstrained Application Mode';
    } else if (rawMode === 'PROVIDER_MANAGED') {
      defaultMode = 'PROVIDER_MANAGED';
      defaultTotal = providerAccountLimit;
      defaultInbound = explicitEnvInbound !== null ? explicitEnvInbound : 0;
      defaultMaxOutbound = defaultTotal;
      defaultFavorLast = defaultInbound > 0;
      sourceDesc = `Environment: Provider Managed Trunk Limits (${providerAccountLimit} channels)`;
    }

    const defaultConfig: TelephonyCapacityConfig = {
      provider,
      mode: defaultMode,
      totalChannels: defaultTotal,
      inboundReserved: defaultInbound,
      maxOutboundChannels: defaultMaxOutbound,
      inboundPriorityPolicy: defaultFavorLast ? 'FAVOR_INBOUND_LAST_CHANNEL' : 'EQUAL_SHARED_POOL',
      favorInboundOnLastChannel: defaultFavorLast,
      protectInboundEmergencies: true,
      providerCpsLimit: parseInt(process.env.TELEPHONY_CPS_LIMIT || '5', 10),
      isThrottlingOutbound: false,
      autoReconcileIntervalSeconds: 15,
      sourceDescription: sourceDesc,
      providerLimit: providerAccountLimit,
    };

    // 1. Try Redis cache
    if (this.redis && this.redis.status === 'ready') {
      try {
        const cached = await this.redis.get(`telephony:capacity:config:${provider}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          // Precedence protection: Ensure stale cache does not restore maxOutbound: 1
          parsed.totalChannels = parsed.totalChannels && parsed.totalChannels > 0 ? parsed.totalChannels : defaultTotal;
          parsed.maxOutboundChannels = Math.max(parsed.maxOutboundChannels ?? parsed.totalChannels, parsed.totalChannels);
          parsed.providerLimit = providerAccountLimit;
          return { ...defaultConfig, ...parsed };
        }
      } catch (e: any) {
        this.logger.warn(`[CAPACITY-CACHE] Redis get error: ${e.message}`);
      }
    }

    // 2. Try PostgreSQL IntegrationConfiguration (Highest precedence for administrator changes)
    try {
      const integration = await this.prisma.integrationConfiguration.findFirst({
        where: { provider: provider.toUpperCase() },
      });

      if (integration?.settings && (integration.settings as any).capacityConfig) {
        const saved = (integration.settings as any).capacityConfig as Partial<TelephonyCapacityConfig>;
        const resolvedMode: CapacityPolicyMode = saved.mode || defaultConfig.mode;
        const total = saved.totalChannels !== undefined && saved.totalChannels > 0 ? saved.totalChannels : defaultConfig.totalChannels;
        const inboundRes = saved.inboundReserved !== undefined ? saved.inboundReserved : defaultConfig.inboundReserved;
        const favorLast = saved.favorInboundOnLastChannel !== undefined
          ? saved.favorInboundOnLastChannel
          : (saved.inboundPriorityPolicy === 'FAVOR_INBOUND_LAST_CHANNEL' || inboundRes > 0);

        // Precedence Protection: In a shared pool of 3 channels, maxOutbound defaults to totalChannels.
        // It must not be artificially capped at 1 from legacy configs!
        const maxOut = saved.maxOutboundChannels && saved.maxOutboundChannels > 1
          ? saved.maxOutboundChannels
          : (resolvedMode === 'UNLIMITED_APPLICATION' ? 0 : total);

        const merged: TelephonyCapacityConfig = {
          ...defaultConfig,
          ...saved,
          mode: resolvedMode,
          totalChannels: total,
          inboundReserved: inboundRes,
          maxOutboundChannels: maxOut,
          inboundPriorityPolicy: favorLast ? 'FAVOR_INBOUND_LAST_CHANNEL' : 'EQUAL_SHARED_POOL',
          favorInboundOnLastChannel: favorLast,
          protectInboundEmergencies: saved.protectInboundEmergencies ?? defaultConfig.protectInboundEmergencies,
          providerCpsLimit: saved.providerCpsLimit || defaultConfig.providerCpsLimit,
          sourceDescription: 'Database: Super Admin Persisted Policy',
          providerLimit: providerAccountLimit,
        };

        if (this.redis && this.redis.status === 'ready') {
          await this.redis.set(`telephony:capacity:config:${provider}`, JSON.stringify(merged), 'EX', 600).catch(() => {});
        }
        return merged;
      }
    } catch (dbErr: any) {
      this.logger.warn(`[CAPACITY-DB] Database config lookup error: ${dbErr.message}`);
    }

    return defaultConfig;
  }

  /**
   * Updates runtime capacity configuration (RBAC: Super Admin).
   * Persists changes to PostgreSQL with zero downtime or service restarts.
   */
  async updateCapacityConfig(provider: string, update: Partial<TelephonyCapacityConfig>): Promise<TelephonyCapacityConfig> {
    const current = await this.getCapacityConfig(provider);
    const providerLimit = current.providerLimit || parseInt(process.env.VOBIZ_CHANNEL_CAPACITY || '3', 10);
    
    // If update explicitly provides totalChannels but no mode, switch to CONFIGURED
    let newMode: CapacityPolicyMode = update.mode || current.mode;
    if (!update.mode && update.totalChannels !== undefined && update.totalChannels > 0) {
      newMode = 'CONFIGURED';
    }

    const newTotal = update.totalChannels !== undefined && update.totalChannels > 0 ? update.totalChannels : current.totalChannels;
    const newInboundReserved = update.inboundReserved !== undefined ? update.inboundReserved : current.inboundReserved;
    const favorLast = update.favorInboundOnLastChannel !== undefined
      ? update.favorInboundOnLastChannel
      : (update.inboundPriorityPolicy ? update.inboundPriorityPolicy === 'FAVOR_INBOUND_LAST_CHANNEL' : current.favorInboundOnLastChannel);

    // In a shared pool, maxOutbound defaults to newTotal so outbound can consume available slots
    const newMaxOutbound = newMode === 'UNLIMITED_APPLICATION'
      ? 0
      : (update.maxOutboundChannels && update.maxOutboundChannels > 1 ? update.maxOutboundChannels : newTotal);

    const updated: TelephonyCapacityConfig = {
      ...current,
      ...update,
      mode: newMode,
      totalChannels: newTotal,
      inboundReserved: favorLast ? Math.max(newInboundReserved, 1) : 0,
      maxOutboundChannels: newMaxOutbound,
      favorInboundOnLastChannel: favorLast,
      inboundPriorityPolicy: favorLast ? 'FAVOR_INBOUND_LAST_CHANNEL' : 'EQUAL_SHARED_POOL',
      protectInboundEmergencies: update.protectInboundEmergencies !== undefined ? update.protectInboundEmergencies : current.protectInboundEmergencies,
      providerCpsLimit: update.providerCpsLimit || current.providerCpsLimit || 5,
      sourceDescription: 'Database: Super Admin Persisted Policy',
      providerLimit,
    };

    this.logger.log(
      `[CAPACITY-CONFIG-UPDATE] Provider=${provider} | mode=${newMode} | totalChannels=${newTotal} | maxOutbound=${newMaxOutbound} | favorInboundLast=${favorLast}`,
    );

    // Persist to Postgres
    try {
      const existing = await this.prisma.integrationConfiguration.findFirst({
        where: { provider: provider.toUpperCase() },
      });

      const existingSettings = (existing?.settings as any) || {};
      const newSettings = { ...existingSettings, capacityConfig: updated };

      if (existing) {
        await this.prisma.integrationConfiguration.update({
          where: { id: existing.id },
          data: { settings: newSettings, updatedAt: new Date() },
        });
      } else {
        await this.prisma.integrationConfiguration.create({
          data: {
            provider: provider.toUpperCase(),
            settings: newSettings,
            status: 'CONFIGURED',
            enabled: true,
          },
        });
      }
    } catch (e: any) {
      this.logger.error(`[CAPACITY-PERSIST] Failed to persist config to DB: ${e.message}`);
    }

    // Invalidate & Update Redis cache
    if (this.redis && this.redis.status === 'ready') {
      await this.redis.set(`telephony:capacity:config:${provider}`, JSON.stringify(updated), 'EX', 600).catch(() => {});
    }

    return updated;
  }

  /**
   * Synchronizes configuration on startup.
   */
  private async syncCapacityConfig(provider: string) {
    const config = await this.getCapacityConfig(provider);
    this.logger.log(
      `[CAPACITY-SYNC] Active config: provider=${provider} mode=${config.mode} totalChannels=${config.totalChannels} inboundReserve=${config.inboundReserved} maxOutbound=${config.maxOutboundChannels} favorInboundLast=${config.favorInboundOnLastChannel}`,
    );
  }

  /**
   * Evaluates Provider Call Setup Rate (CPS Safeguard).
   * Prevents overwhelming provider trunks during rapid dialing.
   */
  private checkCpsRateLimit(maxCps: number): boolean {
    const now = Date.now();
    this.recentDials = this.recentDials.filter((ts) => now - ts < 1000);
    if (this.recentDials.length >= maxCps) {
      return false; // Rate limit reached
    }
    this.recentDials.push(now);
    return true;
  }

  /**
   * Distributed Atomic Channel Reservation.
   * Guarantees capacity safety across concurrent workers.
   * Enforces authoritative Vobiz trunk limits and shared capacity calculations.
   */
  async reserveChannel(
    direction: 'INBOUND' | 'OUTBOUND',
    providerCallId: string,
    provider = 'vobiz',
    opts: { isHeld?: boolean; isTransfer?: boolean; queueDepth?: number; emergencyDepth?: number } = {},
  ): Promise<CapacityReservationResult> {
    const config = await this.getCapacityConfig(provider);
    const requestedChannels = opts.isTransfer ? 2 : 1;
    const isUnlimited = config.mode === 'UNLIMITED_APPLICATION';
    const providerLimit = config.providerLimit || parseInt(process.env.VOBIZ_CHANNEL_CAPACITY || '3', 10);

    // CPS Rate Limit safeguard
    if (direction === 'OUTBOUND' && !this.checkCpsRateLimit(config.providerCpsLimit || 5)) {
      this.logger.warn(`[CAPACITY-RATE-LIMIT] Call setup rate exceeded (${config.providerCpsLimit} CPS). Throttling dial.`);
      return { success: false, reason: 'RATE_LIMIT_CPS_EXCEEDED' };
    }

    // Effective capacity strictly respects the provider account limit if lower than application total
    const effectiveTotal = isUnlimited ? 999999 : Math.min(config.totalChannels, providerLimit);
    const effectiveMaxOutbound = isUnlimited ? 999999 : Math.min(config.maxOutboundChannels, effectiveTotal);
    
    // Priority safeguard: If emergency calls are waiting, pause outbound immediately
    if (direction === 'OUTBOUND' && opts.emergencyDepth && opts.emergencyDepth > 0) {
      this.logger.warn(`[CAPACITY-EMERGENCY-PRIORITY] Blocked outbound dial: ${opts.emergencyDepth} emergency calls waiting.`);
      return { success: false, reason: 'THROTTLED_EMERGENCY_PRIORITY' };
    }

    // Priority policy: Inbound reserve channels
    const favorInboundLast = (config.favorInboundOnLastChannel || config.inboundPriorityPolicy === 'FAVOR_INBOUND_LAST_CHANNEL') ? 1 : 0;
    const effectiveInboundReserved = isUnlimited ? 0 : (config.inboundReserved || 0);
    const reservationToken = `tok_${providerCallId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // 1. Try Distributed Atomic Reservation via Redis Lua script
    if (this.redis && this.redis.status === 'ready') {
      try {
        const luaScript = `
          local key_active = KEYS[1]
          local key_res = KEYS[2]
          local call_id = ARGV[1]
          local direction = ARGV[2]
          local requested = tonumber(ARGV[3])
          local max_total = tonumber(ARGV[4])
          local max_outbound = tonumber(ARGV[5])
          local queue_depth = tonumber(ARGV[6])
          local token = ARGV[7]
          local nowMs = ARGV[8]
          local inbound_reserved = tonumber(ARGV[9] or '0')
          local favor_inbound_last = tonumber(ARGV[10] or '0')

          local total_active = tonumber(redis.call('HGET', key_active, 'total') or '0')
          local outbound_active = tonumber(redis.call('HGET', key_active, 'outbound') or '0')
          local inbound_active = tonumber(redis.call('HGET', key_active, 'inbound') or '0')

          -- Priority Policy: Inbound reserve protection and outbound concurrency ceilings
          if direction == 'OUTBOUND' then
            if (outbound_active + requested) > max_outbound then
              return {0, 'EXCEEDS_OUTBOUND_LIMIT', total_active, inbound_active, outbound_active}
            end
            if favor_inbound_last == 1 and (total_active + requested) > (max_total - 1) then
              return {0, 'INSUFFICIENT_INBOUND_RESERVE', total_active, inbound_active, outbound_active}
            end
            if inbound_reserved > 0 and (total_active + requested) > (max_total - inbound_reserved) then
              return {0, 'INSUFFICIENT_INBOUND_RESERVE', total_active, inbound_active, outbound_active}
            end
          end

          if (total_active + requested) <= max_total then
            redis.call('HINCRBY', key_active, 'total', requested)
            if direction == 'OUTBOUND' then
              redis.call('HINCRBY', key_active, 'outbound', requested)
            else
              redis.call('HINCRBY', key_active, 'inbound', requested)
            end

            -- Set reservation record with 2-hour safety TTL
            redis.call('HMSET', key_res, 'call_id', call_id, 'direction', direction, 'channels', requested, 'reservedAt', nowMs, 'token', token or '', 'state', 'RESERVED')
            redis.call('EXPIRE', key_res, 7200)

            local new_total = total_active + requested
            local new_outbound = outbound_active + (direction == 'OUTBOUND' and requested or 0)
            local new_inbound = inbound_active + (direction == 'INBOUND' and requested or 0)

            return {1, 'RESERVED', new_total, new_inbound, new_outbound}
          else
            return {0, 'CAPACITY_EXHAUSTED', total_active, inbound_active, outbound_active}
          end
        `;

        const activeKey = `telephony:capacity:${provider}:active`;
        const resKey = `telephony:reservation:${provider}:${providerCallId}`;
        const nowMs = Date.now().toString();

        const result: any = await (this.redis as any).eval(
          luaScript,
          2,
          activeKey,
          resKey,
          providerCallId,
          direction,
          requestedChannels,
          effectiveTotal,
          effectiveMaxOutbound,
          opts.queueDepth ?? 0,
          reservationToken,
          nowMs,
          effectiveInboundReserved,
          favorInboundLast,
        );

        const isSuccess = result[0] === 1;
        const reason = result[1];

        if (isSuccess) {
          const totalActive = Number(result[2]);
          const inboundActive = Number(result[3]);
          const outboundActive = Number(result[4]);

          this.logger.log(
            `[CAPACITY-RESERVED] [${config.mode}] callId=${providerCallId} dir=${direction} channels=${requestedChannels} totalActive=${totalActive}/${isUnlimited ? '∞' : effectiveTotal}`,
          );

          return {
            success: true,
            allocatedChannels: requestedChannels,
            reservationToken,
            currentUsage: {
              totalActive,
              inboundActive,
              outboundActive,
              availableChannels: isUnlimited ? 9999 : Math.max(effectiveTotal - totalActive, 0),
            },
          };
        } else {
          this.logger.warn(
            `[CAPACITY-REJECTED] callId=${providerCallId} dir=${direction} reason=${reason}`,
          );
          return {
            success: false,
            reason,
          };
        }
      } catch (redisErr: any) {
        this.logger.warn(`[CAPACITY-REDIS] Lua execution failed, falling back to local lock: ${redisErr.message}`);
      }
    }

    // 2. Safe In-Memory Local Fallback (if Redis is down)
    const counters = this.localCounters.get(provider) || { totalActive: 0, inboundActive: 0, outboundActive: 0 };
    if (direction === 'OUTBOUND') {
      if (counters.outboundActive + requestedChannels > effectiveMaxOutbound) {
        return { success: false, reason: 'EXCEEDS_OUTBOUND_LIMIT' };
      }
      if (favorInboundLast === 1 && (counters.totalActive + requestedChannels > effectiveTotal - 1)) {
        return { success: false, reason: 'INSUFFICIENT_INBOUND_RESERVE' };
      }
      if (effectiveInboundReserved > 0 && (counters.totalActive + requestedChannels > effectiveTotal - effectiveInboundReserved)) {
        return { success: false, reason: 'INSUFFICIENT_INBOUND_RESERVE' };
      }
    }

    if (counters.totalActive + requestedChannels <= effectiveTotal) {
      counters.totalActive += requestedChannels;
      if (direction === 'OUTBOUND') counters.outboundActive += requestedChannels;
      else counters.inboundActive += requestedChannels;
      this.localCounters.set(provider, counters);
      this.localReservations.set(providerCallId, { provider, direction, channels: requestedChannels, reservedAt: Date.now(), token: reservationToken });

      return {
        success: true,
        allocatedChannels: requestedChannels,
        reservationToken,
        currentUsage: {
          totalActive: counters.totalActive,
          inboundActive: counters.inboundActive,
          outboundActive: counters.outboundActive,
          availableChannels: isUnlimited ? 9999 : Math.max(effectiveTotal - counters.totalActive, 0),
        },
      };
    }

    return { success: false, reason: 'CAPACITY_EXHAUSTED' };
  }

  /**
   * Atomically releases a channel reservation when a call terminates or fails.
   * If reservationToken is provided, ownership is verified to prevent older calls from releasing newer reservations.
   */
  async releaseChannel(providerCallId: string, provider = 'vobiz', reservationToken?: string): Promise<boolean> {
    this.logger.log(`[CAPACITY-RELEASE] Releasing reservation for callId=${providerCallId} provider=${provider}`);

    // 1. Release in Redis
    if (this.redis && this.redis.status === 'ready') {
      try {
        const luaRelease = `
          local key_active = KEYS[1]
          local key_res = KEYS[2]
          local expected_token = ARGV[1]

          local exists = redis.call('EXISTS', key_res)
          if exists == 1 then
            if expected_token and expected_token ~= '' then
              local current_token = redis.call('HGET', key_res, 'token')
              if current_token and current_token ~= expected_token then
                -- Token mismatch: older timeout attempting to release newer reservation!
                return 0
              end
            end

            local direction = redis.call('HGET', key_res, 'direction')
            local channels = tonumber(redis.call('HGET', key_res, 'channels') or '1')

            redis.call('DEL', key_res)
            
            local total = tonumber(redis.call('HGET', key_active, 'total') or '0')
            local new_total = math.max(total - channels, 0)
            redis.call('HSET', key_active, 'total', new_total)

            if direction == 'OUTBOUND' then
              local outbound = tonumber(redis.call('HGET', key_active, 'outbound') or '0')
              redis.call('HSET', key_active, 'outbound', math.max(outbound - channels, 0))
            else
              local inbound = tonumber(redis.call('HGET', key_active, 'inbound') or '0')
              redis.call('HSET', key_active, 'inbound', math.max(inbound - channels, 0))
            end

            return 1
          end
          return 0
        `;

        const activeKey = `telephony:capacity:${provider}:active`;
        const resKey = `telephony:reservation:${provider}:${providerCallId}`;
        const released = await (this.redis as any).eval(luaRelease, 2, activeKey, resKey, reservationToken || '');

        if (released === 1) {
          this.logger.log(`[CAPACITY-RELEASE-SUCCESS] Released channel in Redis for callId=${providerCallId}`);
          return true;
        }
      } catch (err: any) {
        this.logger.warn(`[CAPACITY-RELEASE-REDIS] Error: ${err.message}`);
      }
    }

    // 2. Release in Local Map
    const res = this.localReservations.get(providerCallId);
    if (res) {
      if (reservationToken && res.token && res.token !== reservationToken) {
        this.logger.warn(`[CAPACITY-RELEASE-LOCAL] Token mismatch for callId=${providerCallId}. Release skipped.`);
        return false;
      }
      this.localReservations.delete(providerCallId);
      const counters = this.localCounters.get(provider) || { totalActive: 0, inboundActive: 0, outboundActive: 0 };
      counters.totalActive = Math.max(counters.totalActive - res.channels, 0);
      if (res.direction === 'OUTBOUND') counters.outboundActive = Math.max(counters.outboundActive - res.channels, 0);
      else counters.inboundActive = Math.max(counters.inboundActive - res.channels, 0);
      this.localCounters.set(provider, counters);
      return true;
    }

    return false;
  }

  /**
   * Real-time capacity utilization status.
   * Authoritative calculation:
   * occupiedChannels = unique active calls + valid pending reservations not already represented by an active call
   * availableChannels = max(0, effectiveCapacity - occupiedChannels)
   */
  async getCapacityStatus(provider = 'vobiz'): Promise<CapacityStatus> {
    const config = await this.getCapacityConfig(provider);
    const providerLimit = config.providerLimit || parseInt(process.env.VOBIZ_CHANNEL_CAPACITY || '3', 10);
    const isUnlimited = config.mode === 'UNLIMITED_APPLICATION';
    const effectiveCapacity = isUnlimited ? 999999 : Math.min(config.totalChannels, providerLimit);

    let totalActive = 0;
    let inboundActive = 0;
    let outboundActive = 0;
    let pendingReservations = 0;
    let staleReservationCount = 0;

    if (this.redis && this.redis.status === 'ready') {
      try {
        const hash = await this.redis.hgetall(`telephony:capacity:${provider}:active`);
        totalActive = parseInt(hash?.total || '0', 10);
        inboundActive = parseInt(hash?.inbound || '0', 10);
        outboundActive = parseInt(hash?.outbound || '0', 10);

        // Scan reservations for pending status and stale count
        const keys = await this.redis.keys(`telephony:reservation:${provider}:*`);
        const now = Date.now();
        for (const k of keys) {
          const res = await this.redis.hgetall(k);
          const ageSeconds = (now - parseInt(res?.reservedAt || '0', 10)) / 1000;
          if (ageSeconds > 45) {
            staleReservationCount++;
          }
          if (res?.state === 'RESERVED' && ageSeconds <= 45) {
            pendingReservations++;
          }
        }
      } catch (e: any) {
        this.logger.warn(`[CAPACITY-STATUS] Redis read error: ${e.message}`);
      }
    } else {
      const counters = this.localCounters.get(provider) || { totalActive: 0, inboundActive: 0, outboundActive: 0 };
      totalActive = counters.totalActive;
      inboundActive = counters.inboundActive;
      outboundActive = counters.outboundActive;
      const now = Date.now();
      for (const res of Array.from(this.localReservations.values())) {
        const ageSeconds = (now - res.reservedAt) / 1000;
        if (ageSeconds > 45) staleReservationCount++;
        else pendingReservations++;
      }
    }

    // Ensure non-negative and bounded
    totalActive = Math.max(totalActive, 0);
    const occupiedChannels = totalActive;
    const availableChannels = isUnlimited ? null : Math.max(effectiveCapacity - occupiedChannels, 0);
    const utilizationPercent = (!isUnlimited && effectiveCapacity > 0)
      ? Math.min(Math.round((occupiedChannels / effectiveCapacity) * 100), 100)
      : null;
    const isThrottled = !isUnlimited && config.favorInboundOnLastChannel && (availableChannels !== null && availableChannels <= 1);

    return {
      provider,
      mode: config.mode,
      totalChannels: config.totalChannels,
      effectiveCapacity,
      providerLimit,
      inboundReserved: config.inboundReserved,
      maxOutboundChannels: config.maxOutboundChannels,
      activeInbound: inboundActive,
      activeOutbound: outboundActive,
      activeHeld: 0,
      totalActive,
      pendingReservations,
      occupiedChannels,
      availableChannels,
      isThrottled,
      utilizationPercent,
      freshnessTimestamp: new Date(),
      isVerifiedRealtime: true,
      protectInboundEmergencies: config.protectInboundEmergencies,
      providerCpsLimit: config.providerCpsLimit || 5,
      sourceDescription: config.sourceDescription || `Shared Pool (${config.totalChannels} channels)`,
      inboundPriorityPolicy: config.inboundPriorityPolicy,
      favorInboundOnLastChannel: config.favorInboundOnLastChannel,
      providerSource: `Vobiz Account Limit (VOBIZ_CHANNEL_CAPACITY: ${providerLimit})`,
      reconciliationStatus: 'SYNCHRONIZED',
      staleReservationCount,
    };
  }

  /**
   * Non-destructive, lifecycle-safe reconciliation daemon.
   * Compares active Redis reservations against PostgreSQL CallSession state.
   * Does NOT delete long-running legitimate calls that are active in the database!
   */
  async reconcileStaleReservations(provider = 'vobiz') {
    try {
      // 1. Fetch active calls in DB (status: RINGING, IN_PROGRESS, CONNECTED)
      const activeDbCalls = await this.prisma.callSession.findMany({
        where: { status: { in: ['RINGING', 'IN_PROGRESS', 'CONNECTED'] } },
        select: { id: true, reason: true, livekitRoom: true, status: true, startedAt: true, createdAt: true },
      });

      const activeIds = new Set<string>();
      activeDbCalls.forEach((c) => {
        if (c.id) activeIds.add(c.id);
        if (c.reason) activeIds.add(c.reason);
        if (c.livekitRoom) activeIds.add(c.livekitRoom);
      });

      // 2. Fetch recent terminal calls in DB to definitively identify dead calls
      const terminalDbCalls = await this.prisma.callSession.findMany({
        where: { status: { in: ['ENDED', 'FAILED', 'CANCELLED', 'MISSED', 'UNANSWERED', 'REJECTED', 'BUSY'] } },
        select: { id: true, reason: true, livekitRoom: true },
        take: 500,
        orderBy: { createdAt: 'desc' },
      });

      const terminalIds = new Set<string>();
      terminalDbCalls.forEach((c) => {
        if (c.id) terminalIds.add(c.id);
        if (c.reason) terminalIds.add(c.reason);
        if (c.livekitRoom) terminalIds.add(c.livekitRoom);
      });

      if (this.redis && this.redis.status === 'ready') {
        const keys = await this.redis.keys(`telephony:reservation:${provider}:*`);
        let leakedCount = 0;
        let preservedActiveCount = 0;

        let trueInbound = 0;
        let trueOutbound = 0;

        for (const key of keys) {
          const callId = key.replace(`telephony:reservation:${provider}:`, '');
          const resData = await this.redis.hgetall(key);
          const reservedAt = parseInt(resData?.reservedAt || '0', 10);
          const ageSeconds = (Date.now() - reservedAt) / 1000;
          const direction = resData?.direction || 'OUTBOUND';
          const channels = parseInt(resData?.channels || '1', 10);

          // If the call is active in the database, preserve it regardless of age!
          if (activeIds.has(callId)) {
            preservedActiveCount++;
            if (direction === 'OUTBOUND') trueOutbound += channels;
            else trueInbound += channels;
            continue;
          }

          // If the call is in terminal DB status OR not found and older than 45s safety grace period, scavenge!
          const isTerminalInDb = terminalIds.has(callId);
          const isAbandonedUnknown = !activeIds.has(callId) && ageSeconds > 45;

          if (isTerminalInDb || isAbandonedUnknown) {
            this.logger.log(`[CAPACITY-RECONCILE] Safely scavenging stale reservation: callId=${callId} age=${Math.round(ageSeconds)}s reason=${isTerminalInDb ? 'TERMINAL_IN_DB' : 'NOT_FOUND_IN_DB'}`);
            await this.redis.del(key);
            leakedCount++;
          } else {
            // Under grace period, preserve
            if (direction === 'OUTBOUND') trueOutbound += channels;
            else trueInbound += channels;
          }
        }

        // Re-synchronize exact active counters in Redis to eliminate any counter drift
        const trueTotal = trueInbound + trueOutbound;
        await this.redis.hmset(`telephony:capacity:${provider}:active`, {
          total: trueTotal.toString(),
          inbound: trueInbound.toString(),
          outbound: trueOutbound.toString(),
        });

        this.logger.log(`[CAPACITY-RECONCILE] Completed for provider=${provider}. Scavenged=${leakedCount} | PreservedActive=${preservedActiveCount} | ActiveCounters synced to total=${trueTotal} (in=${trueInbound}, out=${trueOutbound})`);
      } else {
        // Reconcile in-memory fallback
        for (const [callId, res] of Array.from(this.localReservations.entries())) {
          if (!activeIds.has(callId)) {
            this.localReservations.delete(callId);
          }
        }
        let total = 0;
        let inbound = 0;
        let outbound = 0;
        for (const res of Array.from(this.localReservations.values())) {
          total += res.channels;
          if (res.direction === 'OUTBOUND') outbound += res.channels;
          else inbound += res.channels;
        }
        this.localCounters.set(provider, { totalActive: total, inboundActive: inbound, outboundActive: outbound });
      }
    } catch (err: any) {
      this.logger.error(`[CAPACITY-RECONCILE] Error during reconciliation: ${err.message}`);
    }
  }
}
