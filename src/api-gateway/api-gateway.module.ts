import { Module } from '@nestjs/common';
import { ApiGatewayController } from './api-gateway.controller';
import { QueueOrchestrationModule } from '../queue-orchestration/queue-orchestration.module';
import { AuthGuard } from './auth.guard';

@Module({
  imports: [QueueOrchestrationModule],
  controllers: [ApiGatewayController],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class ApiGatewayModule {}
