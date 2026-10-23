import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { QueueService } from './queue.service';
import type { Redis } from 'ioredis';

@Injectable()
export class QueueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueWorkerService.name);
  private workerInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private readonly queueService: QueueService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {}

  onModuleInit() {
    this.logger.log('Starting Durable Inbound Queue Worker Engine (interval: 3000ms)...');
    // Start continuous dequeue worker polling every 3 seconds
    this.workerInterval = setInterval(() => {
      this.processWaitingQueuePass().catch((err) => {
        this.logger.error(`[QUEUE-WORKER-PASS] Error during worker execution: ${err.message}`);
      });
    }, 3000);
  }

  onModuleDestroy() {
    if (this.workerInterval) {
      clearInterval(this.workerInterval);
      this.workerInterval = null;
    }
    this.logger.log('Durable Inbound Queue Worker Engine stopped.');
  }

  /**
   * Executes a single dequeue pass.
   * Uses a distributed Redis leader lock so that only ONE instance processes the queue
   * in a horizontally scaled multi-worker deployment.
   */
  async processWaitingQueuePass() {
    if (this.isProcessing) return;

    // Distributed Leader Election Lock (5s TTL)
    const lockKey = 'lock:queue:worker:leader';
    let hasLock = false;

    if (this.redis && this.redis.status === 'ready') {
      try {
        const acquired = await this.redis.set(lockKey, 'active', 'EX', 5, 'NX');
        if (!acquired) {
          // Another worker node in the cluster holds the leader lock
          return;
        }
        hasLock = true;
      } catch (err: any) {
        this.logger.warn(`[QUEUE-WORKER-LOCK] Redis leader lock error: ${err.message}`);
      }
    }

    this.isProcessing = true;
    try {
      // Process pending queue items in priority order
      let processedAny = false;
      let iterations = 0;
      const MAX_BATCH_PER_PASS = 5;

      while (iterations < MAX_BATCH_PER_PASS) {
        iterations++;
        const result = await this.queueService.dequeueAndAllocateNext();
        if (!result || !result.assigned) {
          // No more eligible calls or no available agents/capacity
          break;
        }
        processedAny = true;
        this.logger.log(
          `[QUEUE-WORKER] Successfully dequeued & allocated callSession=${result.callSessionId} to agent=${result.agentName} (${result.agentId})`,
        );
      }

      if (processedAny) {
        this.logger.log(`[QUEUE-WORKER-PASS-COMPLETE] Processed batch of waiting calls.`);
      }
    } finally {
      this.isProcessing = false;
      if (hasLock && this.redis) {
        await this.redis.del(lockKey).catch(() => {});
      }
    }
  }
}
