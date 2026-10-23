import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueService } from './queue.service';
import { QueueOrchestrationService } from './queue-orchestration.service';
import { QueueWorkerService } from './queue-worker.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    BullModule.registerQueue({
      name: 'support_queue',
    }),
    BullModule.registerQueue({
      name: 'sales_queue',
    }),
  ],
  providers: [QueueService, QueueOrchestrationService, QueueWorkerService],
  exports: [QueueService, QueueOrchestrationService, QueueWorkerService],
})
export class QueueOrchestrationModule {}
