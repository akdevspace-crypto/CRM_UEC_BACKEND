import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { AgentService } from '../agent/agent.service';

@Processor('support_queue')
export class SupportQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(SupportQueueProcessor.name);

  constructor(private readonly agentService: AgentService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing call ${job.id} from support queue...`);

    // 1. Fetch available agents with 'support' skill
    const availableAgents =
      await this.agentService.getAvailableAgentsBySkill('support');

    if (availableAgents.length === 0) {
      this.logger.warn(
        `No available agents for call ${job.id}. Re-queueing...`,
      );
      throw new Error('No agents available - trigger backoff');
    }

    // 2. Skill-based Round Robin Allocation
    const selectedAgent = availableAgents.sort(
      (a, b) => a.lastActive - b.lastActive,
    )[0];

    // 3. Mark agent as BUSY in Redis to prevent double booking
    await this.agentService.updateAgentStatus(selectedAgent.id, 'BUSY');

    // 4. Return agent data to trigger WebSocket Gateway signaling
    return { assignedAgentId: selectedAgent.id, callData: job.data };
  }
}
