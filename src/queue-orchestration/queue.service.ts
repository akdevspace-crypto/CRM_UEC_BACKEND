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
      // 1. Build eligibility query - require AVAILABLE, activeCalls: 0, and ACTIVE socket connection!
      const where: any = {
        status: 'AVAILABLE',
        isDeleted: false,
        activeCalls: 0, // Enforce single active voice call capacity
        socketId: { not: null }, // Critical: prevent assigning to disconnected agents
      };

      if (department && department !== 'GENERAL' && !isEmergency) {
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
  async releaseAgentReservation(agentIdOrUserId: string, callSid?: string): Promise<boolean> {
    this.logger.log(`[QUEUE-RELEASE] Releasing reservation for agent ${agentIdOrUserId} callSid=${callSid}`);
    try {
      // 1. Resolve agent by id OR userId
      const agent = await this.prisma.agent.findFirst({
        where: { OR: [{ id: agentIdOrUserId }, { userId: agentIdOrUserId }] },
      });
      if (!agent) {
        this.logger.warn(`[QUEUE-RELEASE] No agent found matching ${agentIdOrUserId}`);
        return false;
      }

      // 2. Clear Redis lock ONLY if it was locked for THIS callSid (or if no callSid specified)
      if (this.redis && this.redis.status === 'ready') {
        const lockKey = `lock:agent:${agent.id}:reservation`;
        if (callSid) {
          const currentLock = await this.redis.get(lockKey);
          if (currentLock === callSid) {
            await this.redis.del(lockKey);
            this.logger.log(`[QUEUE-RELEASE] Redis reservation lock cleared for agent ${agent.id} callSid=${callSid}`);
          } else if (currentLock) {
            this.logger.warn(`[QUEUE-RELEASE] Redis reservation lock for agent ${agent.id} belongs to different call (${currentLock} vs ${callSid}). Skipping lock deletion.`);
          }
        } else {
          await this.redis.del(lockKey).catch(() => {});
        }
      }

      // 3. Count remaining ACTIVE calls for this agent in the database to prevent prematurely setting AVAILABLE or activeCalls: 0
      const isUuid = Boolean(callSid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callSid));
      const notConditions: any[] = [];
      if (callSid) {
        notConditions.push({ reason: callSid }, { livekitRoom: callSid });
        if (isUuid) {
          notConditions.push({ id: callSid });
        }
      }

      const remainingActiveCount = await this.prisma.callSession.count({
        where: {
          status: { in: ['RINGING', 'IN_PROGRESS'] },
          ...(notConditions.length > 0 ? { NOT: { OR: notConditions } } : {}),
          OR: [
            { calleeUserId: agent.userId },
            { callerUserId: agent.userId },
            { participants: { some: { agentId: agent.id, leftAt: null } } }
          ]
        }
      });

      await this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          activeCalls: Math.max(0, remainingActiveCount),
          status: remainingActiveCount === 0 ? 'AVAILABLE' : 'BUSY',
        },
      });

      this.logger.log(`[QUEUE-RELEASE-SUCCESS] Agent ${agent.id} updated (activeCalls: ${remainingActiveCount}, status: ${remainingActiveCount === 0 ? 'AVAILABLE' : 'BUSY'})`);
      return true;
    } catch (err: any) {
      this.logger.error(`[QUEUE-RELEASE] Failed to release agent ${agentIdOrUserId}: ${err.message}`);
      return false;
    }
  }

  /**
   * Track call entering queue item table
   */
  async enqueueCallItem(callSessionId: string, customerId?: string, department = 'GENERAL', priority = 'NORMAL') {
    try {
      const isValidUuid = (val?: string) =>
        typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
      const safeCallSessionId = isValidUuid(callSessionId) ? callSessionId : null;
      const safeCustomerId = isValidUuid(customerId) ? customerId : '00000000-0000-0000-0000-000000000000';

      return await (this.prisma as any).queueItem.create({
        data: {
          callSessionId: safeCallSessionId,
          customerId: safeCustomerId,
          department,
          priority,
          status: 'WAITING',
          outcome: callSessionId, // Store original callSid string in outcome during WAITING
          enteredAt: new Date(),
        },
      });
    } catch (e: any) {
      this.logger.warn(`[QUEUE-ITEM] Could not create queue item: ${e.message}`);
      return null;
    }
  }

  /**
   * Dequeues the next waiting call item in priority order (EMERGENCY > HIGH > NORMAL > LOW)
   * and allocates it to an available agent with active browser WebSocket connectivity.
   */
  async dequeueAndAllocateNext(department?: string): Promise<{ assigned: boolean; callSessionId?: string; agentId?: string; agentName?: string } | null> {
    try {
      // 1. Fetch pending calls waiting in queue
      const waitingItems = await (this.prisma as any).queueItem.findMany({
        where: {
          status: 'WAITING',
          ...(department ? { department } : {}),
        },
        orderBy: [{ enteredAt: 'asc' }],
        take: 20,
      });

      if (!waitingItems || waitingItems.length === 0) {
        return null;
      }

      // 2. Sort by priority weight
      const priorityWeights: Record<string, number> = {
        EMERGENCY: 4,
        HIGH: 3,
        NORMAL: 2,
        LOW: 1,
      };

      waitingItems.sort((a: any, b: any) => {
        const weightA = priorityWeights[a.priority] || 2;
        const weightB = priorityWeights[b.priority] || 2;
        if (weightA !== weightB) return weightB - weightA;
        return new Date(a.enteredAt).getTime() - new Date(b.enteredAt).getTime();
      });

      const nextItem = waitingItems[0];
      const now = Date.now();
      const waitSeconds = Math.floor((now - new Date(nextItem.enteredAt).getTime()) / 1000);
      const maxWaitSeconds = 300; // 5 minutes max wait before overflow

      // 3. Check for Queue Timeout Overflow
      if (waitSeconds > maxWaitSeconds) {
        this.logger.warn(`[QUEUE-TIMEOUT] Call ${nextItem.callSessionId || nextItem.id} timed out after ${waitSeconds}s in queue. Triggering overflow.`);
        await (this.prisma as any).queueItem.update({
          where: { id: nextItem.id },
          data: { status: 'OVERFLOW', outcome: 'OVERFLOW_CALLBACK', waitDuration: waitSeconds },
        });
        return null;
      }

      // 4. Attempt to allocate an available agent
      const assignedAgent = await this.allocateAgent({
        department: nextItem.department,
        callSid: nextItem.callSessionId || nextItem.id,
        isEmergency: nextItem.priority === 'EMERGENCY',
      });

      if (!assignedAgent) {
        // No agent currently free or available
        return null;
      }

      // 5. Update QueueItem to ASSIGNED
      const returnedCallSid = nextItem.callSessionId || nextItem.outcome || nextItem.id;

      await (this.prisma as any).queueItem.update({
        where: { id: nextItem.id },
        data: {
          status: 'ASSIGNED',
          assignedAgentId: assignedAgent.id,
          assignedAt: new Date(),
          waitDuration: waitSeconds,
          outcome: 'ANSWERED',
        },
      });

      this.logger.log(`[QUEUE-DEQUEUED] Dequeued callSessionId=${returnedCallSid} -> assigned to agent=${assignedAgent.name}`);

      return {
        assigned: true,
        callSessionId: returnedCallSid,
        agentId: assignedAgent.id,
        agentName: assignedAgent.name,
      };
    } catch (e: any) {
      this.logger.error(`[QUEUE-DEQUEUE] Error: ${e.message}`);
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
      waitingQueueDetails: waitingQueueItems.map((item: any) => ({
        id: item.id,
        callSessionId: item.callSessionId,
        department: item.department || 'GENERAL',
        priority: item.priority || 'NORMAL',
        enteredAt: item.enteredAt,
        waitSeconds: item.enteredAt
          ? Math.max(Math.floor((now.getTime() - new Date(item.enteredAt).getTime()) / 1000), 0)
          : 0,
      })),
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
