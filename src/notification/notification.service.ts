import { Injectable, Logger, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async triggerSlaAlert(queueId: string, waitTime: number) {
    this.logger.warn(`SLA BREACH! Queue ${queueId} wait time: ${waitTime}s`);

    // Publish alert to all connected Supervisors via WebSocket Gateway
    await this.redis.publish(
      'supervisor_alerts',
      JSON.stringify({
        type: 'SLA_BREACH',
        queueId,
        message: `Wait time exceeded threshold: ${waitTime} seconds`,
      }),
    );
  }

  async sendAppointmentNotification(payload: any) {
    this.logger.log(`Sending appointment notification to ${payload.customerId}`);
    await this.redis.publish(
      'appointment_notifications',
      JSON.stringify(payload)
    );
  }
}
