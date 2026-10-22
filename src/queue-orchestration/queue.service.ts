import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Redis } from 'ioredis';

export interface AgentAllocationOptions {
  department?: string;
  requiredSkills?: string[];
  serviceCategory?: string;
  isEmergency?: boolean;
  strategy?: 'LONGEST_IDLE' | 'ROUND_ROBIN' | 'SKILL_BASED';
  callSid?: string;
  ringTimeoutSeconds?: number;
}

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {}

  /**
   * Allocates an available agent using atomic Redis mutex reservation and PostgreSQL transactional locking.
   * Prevents concurrent calls from reserving the same single-call agent simultaneously.
   */
  async allocateAgent(
    departmentOrOptions?: string | AgentAllocationOptions,
  ): Promise<any | null> {
    let opts: AgentAllocationOptions = {};
    if (typeof departmentOrOptions === 'string') {
      opts = { department: departmentOrOptions };
    } else if (departmentOrOptions) {
      opts = departmentOrOptions;
    }

    const {
      department,
      requiredSkills = [],
      serviceCategory,
      isEmergency = false,
      strategy = 'LONGEST_IDLE',
      callSid = `call_${Date.now()}`,
      ringTimeoutSeconds = 25,
    } = opts;

    this.logger.log(
      `[QUEUE-ALLOCATE] Allocating agent | dept=${department || 'any'} emergency=${isEmergency} strategy=${strategy} callSid=${callSid}`,
    );

    try {
      // 1. Build eligibility query
      const where: any = {
        status: 'AVAILABLE',
        isDeleted: false,
        activeCalls: 0, // Enforce single active voice call capacity
      };

      if (department) {
        where.department = department;
      }

      if (requiredSkills.length > 0) {
        where.skills = { hasSome: requiredSkills };
      }

      // Order by strategy
      let orderBy: any[] = [{ lastAssignedAt: 'asc' }, { activeCalls: 'asc' }];
      if (strategy === 'ROUND_ROBIN') {
        orderBy = [{ lastAssignedAt: 'asc' }];
      }

      // 2. Query eligible candidates
      const candidates = await this.prisma.agent.findMany({
        where,
        orderBy,
        take: 10,
        include: { user: { select: { email: true, role: true } } },
      });

      if (candidates.length === 0) {
        this.logger.warn(`[QUEUE-ALLOCATE] No eligible agents available in pool for dept=${department || 'any'}`);
        return null;
      }

      // 3. Atomically attempt reservation on candidates one-by-one
      for (const candidate of candidates) {
        const lockKey = `lock:agent:${candidate.id}:reservation`;
        let redisLocked = false;

        // Try Redis atomic lock if Redis is online
        if (this.redis && this.redis.status === 'ready') {
          try {
            // SET lock NX EX ringTimeoutSeconds
            const setRes = await this.redis.set(lockKey, callSid, 'EX', ringTimeoutSeconds, 'NX');
            if (setRes !== 'OK') {
              this.logger.debug(`[QUEUE-LOCK] Agent ${candidate.id} (${candidate.name}) is reserved by another call in Redis. Skipping.`);
              continue;
            }
            redisLocked = true;
          } catch (redisErr: any) {
            this.logger.warn(`[QUEUE-LOCK] Redis error during lock check: ${redisErr.message}`);
          }
        }

        // Database-backed transactional reservation verify & commit
        try {
          const reservedAgent = await this.prisma.$transaction(async (tx) => {
            const current = await tx.agent.findUnique({
              where: { id: candidate.id },
            });

            if (!current || current.status !== 'AVAILABLE' || current.activeCalls > 0 || current.isDeleted) {
              return null;
            }

            return tx.agent.update({
              where: { id: candidate.id },
              data: {
                status: 'BUSY',
                activeCalls: { increment: 1 },
                lastAssignedAt: new Date(),
              },
              include: { user: { select: { email: true, role: true } } },
            });
          });

          if (reservedAgent) {
            this.logger.log(
              `[QUEUE-ALLOCATE-SUCCESS] Reserved agent ${reservedAgent.name} (${reservedAgent.id}) for call ${callSid}`,
            );
            return reservedAgent;
          } else {
            // Reservation collision in database, release Redis lock
            if (redisLocked && this.redis) {
              await this.redis.del(lockKey).catch(() => {});
            }
          }
        } catch (dbErr: any) {
          if (redisLocked && this.redis) {
            await this.redis.del(lockKey).catch(() => {});
          }
          this.logger.warn(`[QUEUE-ALLOCATE] DB transaction failure for candidate ${candidate.id}: ${dbErr.message}`);
        }
      }

      this.logger.warn(`[QUEUE-ALLOCATE] All ${candidates.length} candidates failed atomic reservation lock.`);
      return null;
    } catch (error: any) {
      this.logger.error(`[QUEUE-ALLOCATE] Fatal error during agent allocation: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Releases an agent's reservation/call lock, resets activeCalls and marks agent AVAILABLE.
   */
  async releaseAgentReservation(agentId: string, callSid?: string): Promise<boolean> {
    this.logger.log(`[QUEUE-RELEASE] Releasing reservation for agent ${agentId} callSid=${callSid}`);
    try {
      // 1. Clear Redis lock
      if (this.redis && this.redis.status === 'ready') {
        const lockKey = `lock:agent:${agentId}:reservation`;
        await this.redis.del(lockKey).catch(() => {});
      }

      // 2. Update agent in database
      const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
      if (!agent) return false;

      const newActiveCalls = Math.max((agent.activeCalls || 1) - 1, 0);
      await this.prisma.agent.update({
        where: { id: agentId },
        data: {
          activeCalls: newActiveCalls,
          status: newActiveCalls === 0 ? 'AVAILABLE' : 'BUSY',
        },
      });

      this.logger.log(`[QUEUE-RELEASE-SUCCESS] Agent ${agentId} released (activeCalls: ${newActiveCalls})`);
      return true;
    } catch (err: any) {
      this.logger.error(`[QUEUE-RELEASE] Failed to release agent ${agentId}: ${err.message}`);
      return false;
    }
  }

  /**
   * Track call entering queue item table
   */
  async enqueueCallItem(callSessionId: string, customerId?: string, department = 'GENERAL', priority = 'NORMAL') {
    try {
      return await (this.prisma as any).queueItem.create({
        data: {
          callSessionId,
          customerId: customerId || '00000000-0000-0000-0000-000000000000',
          department,
          priority,
          status: 'WAITING',
          enteredAt: new Date(),
        },
      });
    } catch (e: any) {
      this.logger.warn(`[QUEUE-ITEM] Could not create queue item: ${e.message}`);
      return null;
    }
  }

  /**
   * Real-time contact-center queue operations dashboard metrics
   */
  async getQueueOperationsDashboard() {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [
      waitingQueueItems,
      allAgents,
      callsToday,
      connectedToday,
      missedToday,
      totalQueueDefinitions,
    ] = await Promise.all([
      (this.prisma as any).queueItem.findMany({
        where: { status: 'WAITING' },
        orderBy: { enteredAt: 'asc' },
      }),
      this.prisma.agent.findMany({
        where: { isDeleted: false },
        select: { id: true, name: true, status: true, department: true, activeCalls: true, socketId: true },
      }),
      this.prisma.callSession.count({
        where: { startedAt: { gte: startOfToday } },
      }),
      this.prisma.callSession.count({
        where: { startedAt: { gte: startOfToday }, status: 'CONNECTED' },
      }),
      this.prisma.callSession.count({
        where: { startedAt: { gte: startOfToday }, status: { in: ['MISSED', 'UNANSWERED', 'REJECTED'] } },
      }),
      this.prisma.queue.count({ where: { isActive: true } }),
    ]);

    // Compute oldest wait time
    let oldestWaitSeconds = 0;
    if (waitingQueueItems.length > 0 && waitingQueueItems[0].enteredAt) {
      oldestWaitSeconds = Math.max(
        Math.floor((now.getTime() - new Date(waitingQueueItems[0].enteredAt).getTime()) / 1000),
        0,
      );
    }

    // Agent status breakdown
    const agentBreakdown = {
      available: allAgents.filter((a) => a.status === 'AVAILABLE').length,
      busy: allAgents.filter((a) => a.status === 'BUSY' || a.activeCalls > 0).length,
      break: allAgents.filter((a) => a.status === 'BREAK').length,
      wrapUp: allAgents.filter((a) => a.status === 'WRAP_UP').length,
      offline: allAgents.filter((a) => a.status === 'OFFLINE').length,
      total: allAgents.length,
    };

    const abandonedToday = Math.max(callsToday - connectedToday - missedToday, 0);
    const answerRate = callsToday > 0 ? Math.round((connectedToday / callsToday) * 100) : 100;

    return {
      queueDepth: waitingQueueItems.length,
      waitingCalls: waitingQueueItems.length,
      oldestWaitSeconds,
      activeQueues: totalQueueDefinitions,
      agents: agentBreakdown,
      metricsToday: {
        offered: callsToday,
        answered: connectedToday,
        missed: missedToday,
        abandoned: abandonedToday,
        answerRate,
      },
      agentRoster: allAgents.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        department: a.department || 'General',
        activeCalls: a.activeCalls,
        isOnline: Boolean(a.socketId),
      })),
    };
  }
}
