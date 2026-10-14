import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';

@Injectable()
export class QueueOrchestrationService {
  private readonly logger = new Logger(QueueOrchestrationService.name);

  constructor(
    @InjectQueue('support_queue') private supportQueue: Queue,
    @InjectQueue('sales_queue') private salesQueue: Queue,
  ) {}

  async enqueueCall(callData: any, type: 'support' | 'sales') {
    this.logger.log(`Incoming call routed to ${type} queue`);
    const queue = type === 'support' ? this.supportQueue : this.salesQueue;

    // Add call to BullMQ with high priority if emergency
    await queue.add('route_call', callData, {
      priority: callData.isEmergency ? 1 : 10,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  }

  async allocateAgent(department?: string): Promise<any | null> {
    this.logger.log(
      `Attempting to allocate agent for department: ${department || 'any'}`,
    );

    // Using Prisma transaction for atomic allocation
    // In NestJS we import PrismaService. We need to inject it.
    // I will add it to the constructor shortly.
  }

  async getQueueMetrics() {
    const supportCount = await this.supportQueue.getWaitingCount();
    const salesCount = await this.salesQueue.getWaitingCount();
    return { supportCount, salesCount };
  }
}
