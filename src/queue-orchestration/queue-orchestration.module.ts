import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueService } from './queue.service';
import { QueueOrchestrationService } from './queue-orchestration.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: 'support_queue',
    }),
    BullModule.registerQueue({
      name: 'sales_queue',
    }),
  ],
  providers: [QueueService, QueueOrchestrationService],
  exports: [QueueService, QueueOrchestrationService],
})
export class QueueOrchestrationModule {}
