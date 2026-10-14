import { Controller, Post, Body, UseGuards, Get, Logger } from '@nestjs/common';
import { QueueOrchestrationService } from '../queue-orchestration/queue-orchestration.service';
import { Public } from './auth.guard';

@Controller('api/v1')
export class ApiGatewayController {
  private readonly logger = new Logger(ApiGatewayController.name);

  constructor(
    private readonly queueOrchestrationService: QueueOrchestrationService,
  ) {}

  @Public()
  @Get('health')
  healthCheck() {
    return { status: 'OK', timestamp: new Date().toISOString() };
  }

  // Webhook for the external IVR system to inject calls into the queue
  @Post('ivr/webhook/inbound')
  async handleInboundCallFromIVR(
    @Body()
    payload: {
      customerId: string;
      department: string;
      isEmergency: boolean;
    },
  ) {
    this.logger.log(
      `Received inbound call from IVR for customer: ${payload.customerId}`,
    );

    // Map IVR department string to our internal queue types
    const queueType = payload.department === 'sales' ? 'sales' : 'support';

    await this.queueOrchestrationService.enqueueCall(payload, queueType);

    return {
      status: 'QUEUED',
      message: `Call routed to ${queueType} queue successfully.`,
    };
  }
}
