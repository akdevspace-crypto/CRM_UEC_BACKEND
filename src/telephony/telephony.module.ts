import { Module } from '@nestjs/common';
import { TelephonyService } from './telephony.service';
import { LivekitService } from './livekit.service';
import { TelephonyGateway } from './telephony.gateway';
import { TelephonyController } from './telephony.controller';
import { VobizController } from './vobiz.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueOrchestrationModule } from '../queue-orchestration/queue-orchestration.module';
import { VobizProvider } from './providers/vobiz.provider';
import { ExotelProvider } from './providers/exotel.provider';
import { RedisModule } from '../redis/redis.module';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
  imports: [PrismaModule, QueueOrchestrationModule, RedisModule, AnalyticsModule],
  controllers: [TelephonyController, VobizController],
  providers: [TelephonyService, LivekitService, TelephonyGateway, VobizProvider, ExotelProvider],
  exports: [TelephonyService, LivekitService],
})
export class TelephonyModule {}
