import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { ApiGatewayModule } from './api-gateway/api-gateway.module';
import { AuthGuard } from './api-gateway/auth.guard';
import { RolesGuard } from './api-gateway/roles.guard';
import { AgentModule } from './agent/agent.module';
import { QueueOrchestrationModule } from './queue-orchestration/queue-orchestration.module';
import { TelephonyModule } from './telephony/telephony.module';
import { SessionLifecycleModule } from './session-lifecycle/session-lifecycle.module';
import { OmnichannelModule } from './omnichannel/omnichannel.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { RecordingModule } from './recording/recording.module';
import { NotificationModule } from './notification/notification.module';
import { BookingModule } from './booking/booking.module';
import { AuthModule } from './auth/auth.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { WebsiteLeadsModule } from './webhooks/leads/website-leads.module';
import { SuperAdminModule } from './super-admin/super-admin.module';

const getRedisConnectionOptions = () => {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  try {
    const parsed = new URL(redisUrl);
    return {
      host: parsed.hostname || 'localhost',
      port: parsed.port ? parseInt(parsed.port, 10) : 6379,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      db: parsed.pathname ? parseInt(parsed.pathname.substring(1), 10) || 0 : 0,
      maxRetriesPerRequest: null,
    };
  } catch (err) {
    return {
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    };
  }
};

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    BullModule.forRoot({
      connection: getRedisConnectionOptions(),
    }),
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 100,
    }]),
    ApiGatewayModule,
    AgentModule,
    QueueOrchestrationModule,
    TelephonyModule,
    SessionLifecycleModule,
    OmnichannelModule,
    AnalyticsModule,
    RecordingModule,
    NotificationModule,
    BookingModule,
    AuthModule,
    ApprovalsModule,
    WebsiteLeadsModule,
    SuperAdminModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
