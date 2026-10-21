import { Injectable, Inject, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service'; // Assuming PrismaModule handles this

@Injectable()
export class SessionLifecycleService {
  private readonly logger = new Logger(SessionLifecycleService.name);

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  async createCallSession(
    agentId: string,
    customerId: string,
    queueId?: string,
  ) {
    // 1. Resolve authentic user and customer records to satisfy relations
    let validUserId: string | null = null;
    if (agentId) {
      const user = await this.prisma.user.findFirst({
        where: { OR: [{ id: agentId }, { agentProfile: { id: agentId } }] }
      }).catch(() => null);
      if (user) validUserId = user.id;
    }

    let validCustomerId: string | null = null;
    if (customerId) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: customerId }
      }).catch(() => null);
      if (customer) validCustomerId = customer.id;
    }

    const session = await this.prisma.callSession.create({
      data: {
        calleeUserId: validUserId,
        customerId: validCustomerId,
        status: 'RINGING',
        startedAt: new Date(),
        reason: queueId ? `Queue:${queueId}` : undefined,
      }
    });

    // 2. Cache active session in Redis for fast failover recovery
    await this.redis.set(
      `active_session:${agentId}`,
      JSON.stringify({
        sessionId: session.id,
        customerId: validCustomerId || customerId,
        timestamp: Date.now(),
      }),
      'EX',
      3600,
    ); // 1 hour TTL

    this.logger.log(`Session created: ${session.id} for Agent: ${agentId}`);
    return session;
  }

  async recoverSession(agentId: string) {
    // If browser refreshes, fetch active session from Redis to re-establish WebRTC
    const data = await this.redis.get(`active_session:${agentId}`);
    if (data) {
      this.logger.log(`Recovered session for Agent: ${agentId}`);
      return JSON.parse(data);
    }
    return null;
  }

  async endCallSession(agentId: string, sessionId: string) {
    // 1. Update authentic database session
    if (sessionId) {
      await this.prisma.callSession.updateMany({
        where: { id: sessionId },
        data: {
          status: 'ENDED',
          endedAt: new Date(),
        }
      }).catch((err) => {
        this.logger.warn(`Failed to update CallSession in DB: ${err.message}`);
      });
    }

    // 2. Clear Redis session cache
    await this.redis.del(`active_session:${agentId}`);
    this.logger.log(`Session ended: ${sessionId}`);
  }
}
