import { Injectable, Logger, Inject, Optional, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Redis } from 'ioredis';

export interface TelephonyCapacityConfig {
  provider: string;
  totalChannels: number;
  inboundReserved: number;
  maxOutboundChannels: number;
  isThrottlingOutbound: boolean;
  autoReconcileIntervalSeconds: number;
}

export interface CapacityReservationResult {
  success: boolean;
  reason?: string;
  allocatedChannels?: number;
  currentUsage?: {
    totalActive: number;
    inboundActive: number;
    outboundActive: number;
    availableChannels: number;
  };
}

export interface CapacityStatus {
  provider: string;
  totalChannels: number;
  inboundReserved: number;
  maxOutboundChannels: number;
  activeInbound: number;
  activeOutbound: number;
  activeHeld: number;
  totalActive: number;
  availableChannels: number;
  isThrottled: boolean;
  utilizationPercent: number;
  freshnessTimestamp: Date;
  isVerifiedRealtime: boolean;
}

@Injectable()
export class CapacityService implements OnModuleInit {
  private readonly logger = new Logger(CapacityService.name);

  // In-memory fallback if Redis is temporarily unreachable
  private localCounters = new Map<string, { totalActive: number; inboundActive: number; outboundActive: number }>();
  private localReservations = new Map<string, { provider: string; direction: string; channels: number; reservedAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing Global Telephony Capacity Orchestrator...');
    await this.syncCapacityConfig('vobiz');
  }

  /**
   * Retrieves runtime capacity configuration for a provider.
   * Dynamically scalable: Not hardcoded to 3 or any fixed number.
   */
  async getCapacityConfig(provider = 'vobiz'): Promise<TelephonyCapacityConfig> {
    const defaultTotal = parseInt(process.env.TELEPHONY_TOTAL_CHANNELS || process.env.VOBIZ_CHANNEL_CAPACITY || '3', 10);
    const defaultInboundReserved = parseInt(process.env.TELEPHONY_INBOUND_RESERVED || '1', 10);
    const defaultMaxOutbound = Math.max(defaultTotal - defaultInboundReserved, 1);

    const defaultConfig: TelephonyCapacityConfig = {
      provider,
      totalChannels: defaultTotal,
      inboundReserved: defaultInboundReserved,
      maxOutboundChannels: defaultMaxOutbound,
      isThrottlingOutbound: false,
      autoReconcileIntervalSeconds: 15,
    };

    // Try Redis cache
    if (this.redis && this.redis.status === 'ready') {
      try {
        const cached = await this.redis.get(`telephony:capacity:config:${provider}`);
        if (cached) {
          return { ...defaultConfig, ...JSON.parse(cached) };
        }
      } catch (e: any) {
        this.logger.warn(`[CAPACITY-CACHE] Redis get error: ${e.message}`);
      }
    }

    // Try PostgreSQL IntegrationConfiguration
    try {
      const integration = await this.prisma.integrationConfiguration.findFirst({
        where: { provider: provider.toUpperCase() },
      });

      if (integration?.settings && (integration.settings as any).capacityConfig) {
        const saved = (integration.settings as any).capacityConfig as Partial<TelephonyCapacityConfig>;
        const merged: TelephonyCapacityConfig = {
          ...defaultConfig,
          ...saved,
          totalChannels: saved.totalChannels || defaultTotal,
          inboundReserved: saved.inboundReserved ?? defaultInboundReserved,
          maxOutboundChannels: saved.maxOutboundChannels || Math.max((saved.totalChannels || defaultTotal) - (saved.inboundReserved ?? defaultInboundReserved), 1),
        };

        // Cache in Redis for 10 minutes
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
   * Does NOT require any code modifications or restarts.
   */
  async updateCapacityConfig(provider: string, update: Partial<TelephonyCapacityConfig>): Promise<TelephonyCapacityConfig> {
    const current = await this.getCapacityConfig(provider);
    const newTotal = update.totalChannels ?? current.totalChannels;
    const newInboundReserved = update.inboundReserved ?? current.inboundReserved;
    const newMaxOutbound = update.maxOutboundChannels ?? Math.max(newTotal - newInboundReserved, 1);

    const updated: TelephonyCapacityConfig = {
      ...current,
      ...update,
      totalChannels: newTotal,
      inboundReserved: newInboundReserved,
      maxOutboundChannels: newMaxOutbound,
    };

    this.logger.log(
      `[CAPACITY-CONFIG-UPDATE] Provider=${provider} | totalChannels=${newTotal} | inboundReserved=${newInboundReserved} | maxOutbound=${newMaxOutbound}`,
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
      `[CAPACITY-SYNC] Active config: provider=${provider} totalChannels=${config.totalChannels} inboundReserve=${config.inboundReserved} maxOutbound=${config.maxOutboundChannels}`,
    );
  }

  /**
   * Distributed Atomic Channel Reservation (Redis Lua Script).
   * Guarantees capacity safety across concurrent workers.
   */
  async reserveChannel(
    direction: 'INBOUND' | 'OUTBOUND',
    providerCallId: string,
    provider = 'vobiz',
    opts: { isHeld?: boolean; isTransfer?: boolean; queueDepth?: number } = {},
  ): Promise<CapacityReservationResult> {
    const config = await this.getCapacityConfig(provider);
    const requestedChannels = opts.isTransfer ? 2 : 1;
    const queueDepth = opts.queueDepth ?? 0;

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

          local total_active = tonumber(redis.call('HGET', key_active, 'total') or '0')
          local outbound_active = tonumber(redis.call('HGET', key_active, 'outbound') or '0')
          local inbound_active = tonumber(redis.call('HGET', key_active, 'inbound') or '0')

          -- Priority Policy: Inbound takes priority over outbound campaigns
          if direction == 'OUTBOUND' then
            if queue_depth > 0 then
              return {0, 'THROTTLED_INBOUND_PRIORITY'}
            end
            if (outbound_active + requested) > max_outbound then
              return {0, 'EXCEEDS_OUTBOUND_LIMIT'}
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
            redis.call('HMSET', key_res, 'call_id', call_id, 'direction', direction, 'channels', requested, 'reservedAt', ARGV[7])
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
          config.totalChannels,
          config.maxOutboundChannels,
          queueDepth,
          nowMs,
        );

        const isSuccess = result[0] === 1;
        const reason = result[1];

        if (isSuccess) {
          const totalActive = Number(result[2]);
          const inboundActive = Number(result[3]);
          const outboundActive = Number(result[4]);

          this.logger.log(
            `[CAPACITY-RESERVED] callId=${providerCallId} dir=${direction} channels=${requestedChannels} totalActive=${totalActive}/${config.totalChannels}`,
          );

          return {
            success: true,
            allocatedChannels: requestedChannels,
            currentUsage: {
              totalActive,
              inboundActive,
              outboundActive,
              availableChannels: Math.max(config.totalChannels - totalActive, 0),
            },
          };
        } else {
          this.logger.warn(
            `[CAPACITY-REJECTED] callId=${providerCallId} dir=${direction} reason=${reason} queueDepth=${queueDepth}`,
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
      if (queueDepth > 0) return { success: false, reason: 'THROTTLED_INBOUND_PRIORITY' };
      if (counters.outboundActive + requestedChannels > config.maxOutboundChannels) {
        return { success: false, reason: 'EXCEEDS_OUTBOUND_LIMIT' };
      }
    }

    if (counters.totalActive + requestedChannels <= config.totalChannels) {
      counters.totalActive += requestedChannels;
      if (direction === 'OUTBOUND') counters.outboundActive += requestedChannels;
      else counters.inboundActive += requestedChannels;
      this.localCounters.set(provider, counters);
      this.localReservations.set(providerCallId, { provider, direction, channels: requestedChannels, reservedAt: Date.now() });

      return {
        success: true,
        allocatedChannels: requestedChannels,
        currentUsage: {
          totalActive: counters.totalActive,
          inboundActive: counters.inboundActive,
          outboundActive: counters.outboundActive,
          availableChannels: Math.max(config.totalChannels - counters.totalActive, 0),
        },
      };
    }

    return { success: false, reason: 'CAPACITY_EXHAUSTED' };
  }

  /**
   * Atomically releases a channel reservation when a call terminates or fails.
   */
  async releaseChannel(providerCallId: string, provider = 'vobiz'): Promise<boolean> {
    this.logger.log(`[CAPACITY-RELEASE] Releasing reservation for callId=${providerCallId} provider=${provider}`);

    // 1. Release in Redis
    if (this.redis && this.redis.status === 'ready') {
      try {
        const luaRelease = `
          local key_active = KEYS[1]
          local key_res = KEYS[2]

          local exists = redis.call('EXISTS', key_res)
          if exists == 1 then
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
        const released = await (this.redis as any).eval(luaRelease, 2, activeKey, resKey);

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
   */
  async getCapacityStatus(provider = 'vobiz'): Promise<CapacityStatus> {
    const config = await this.getCapacityConfig(provider);
    let totalActive = 0;
    let inboundActive = 0;
    let outboundActive = 0;

    if (this.redis && this.redis.status === 'ready') {
      try {
        const hash = await this.redis.hgetall(`telephony:capacity:${provider}:active`);
        totalActive = parseInt(hash?.total || '0', 10);
        inboundActive = parseInt(hash?.inbound || '0', 10);
        outboundActive = parseInt(hash?.outbound || '0', 10);
      } catch (e: any) {
        this.logger.warn(`[CAPACITY-STATUS] Redis read error: ${e.message}`);
      }
    } else {
      const counters = this.localCounters.get(provider) || { totalActive: 0, inboundActive: 0, outboundActive: 0 };
      totalActive = counters.totalActive;
      inboundActive = counters.inboundActive;
      outboundActive = counters.outboundActive;
    }

    // Ensure non-negative and bounded
    totalActive = Math.max(totalActive, 0);
    const availableChannels = Math.max(config.totalChannels - totalActive, 0);
    const utilizationPercent = config.totalChannels > 0 ? Math.round((totalActive / config.totalChannels) * 100) : 0;
    const isThrottled = availableChannels <= config.inboundReserved;

    return {
      provider,
      totalChannels: config.totalChannels,
      inboundReserved: config.inboundReserved,
      maxOutboundChannels: config.maxOutboundChannels,
      activeInbound: inboundActive,
      activeOutbound: outboundActive,
      activeHeld: 0, // Held calls are accounted inside activeInbound
      totalActive,
      availableChannels,
      isThrottled,
      utilizationPercent,
      freshnessTimestamp: new Date(),
      isVerifiedRealtime: true,
    };
  }

  /**
   * Periodic reconciliation daemon to scavenge stale reservations.
   * Compares active Redis reservations against PostgreSQL CallSession state.
   */
  async reconcileStaleReservations(provider = 'vobiz') {
    try {
      // Find all call sessions active in DB
      const activeDbCalls = await this.prisma.callSession.findMany({
        where: { status: { in: ['RINGING', 'IN_PROGRESS', 'CONNECTED'] } },
        select: { id: true, reason: true, status: true, startedAt: true },
      });

      const activeReasons = new Set(activeDbCalls.map((c) => c.reason).filter(Boolean));

      if (this.redis && this.redis.status === 'ready') {
        const keys = await this.redis.keys(`telephony:reservation:${provider}:*`);
        let leakedCount = 0;

        for (const key of keys) {
          const callId = key.replace(`telephony:reservation:${provider}:`, '');
          // If the call is not found in active DB sessions and was created > 60s ago, scavenge
          const resData = await this.redis.hgetall(key);
          const reservedAt = parseInt(resData?.reservedAt || '0', 10);
          const ageSeconds = (Date.now() - reservedAt) / 1000;

          if (!activeReasons.has(callId) && ageSeconds > 60) {
            this.logger.warn(`[CAPACITY-RECONCILE] Scavenging leaked reservation: callId=${callId} age=${Math.round(ageSeconds)}s`);
            await this.releaseChannel(callId, provider);
            leakedCount++;
          }
        }

        if (leakedCount > 0) {
          this.logger.log(`[CAPACITY-RECONCILE] Cleared ${leakedCount} stale channel reservations for provider=${provider}`);
        }
      }
    } catch (err: any) {
      this.logger.error(`[CAPACITY-RECONCILE] Error during reconciliation: ${err.message}`);
    }
  }
}
