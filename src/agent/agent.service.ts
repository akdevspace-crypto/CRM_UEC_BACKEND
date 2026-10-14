import { Injectable, Inject, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

export type AgentStatus =
  | 'AVAILABLE'
  | 'BUSY'
  | 'BREAK'
  | 'OFFLINE'
  | 'WRAP_UP';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async updateAgentStatus(agentId: string, status: AgentStatus): Promise<void> {
    const key = `agent_status:${agentId}`;
    await this.redis.hset(key, {
      status,
      updatedAt: Date.now(),
    });
    this.logger.log(`Agent ${agentId} status updated to ${status}`);

    // Broadcast status change via Redis Pub/Sub for WebSocket Gateway
    await this.redis.publish(
      'agent_events',
      JSON.stringify({ type: 'STATUS_UPDATE', agentId, status }),
    );
  }

  async getAvailableAgentsBySkill(skill: string): Promise<any[]> {
    // In production, this would intersect Redis available agents with Prisma DB skills.
    // For fast routing, we store skills in Redis hashes on login.
    const keys = await this.redis.keys('agent_status:*');
    const availableAgents = [];

    for (const key of keys) {
      const data = await this.redis.hgetall(key);
      if (data.status === 'AVAILABLE') {
        // add skill check logic here
        const agentId = key.split(':')[1];
        availableAgents.push({
          id: agentId,
          lastActive: parseInt(data.updatedAt),
        });
      }
    }

    return availableAgents;
  }
}
