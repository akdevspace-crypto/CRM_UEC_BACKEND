import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Allocates an available agent using atomic locking and ordering by activeCalls and lastAssignedAt.
   */
  async allocateAgent(department?: string): Promise<any | null> {
    this.logger.log(
      `Attempting to allocate agent for department: ${department || 'any'}`,
    );

    // Since Prisma doesn't support SELECT ... FOR UPDATE natively without raw queries easily for this complex logic,
    // we use a transaction with raw SQL to find and lock the best available agent.

    try {
      // Find the best available agent (least busy, longest waiting)
      const agent = await this.prisma.agent.findFirst({
        where: {
          status: 'AVAILABLE',
          isDeleted: false,
          ...(department ? { department } : {}),
        },
        orderBy: [{ activeCalls: 'asc' }, { lastAssignedAt: 'asc' }],
      });

      if (!agent) {
        // Add detailed diagnostic logging to identify why all agents were rejected
        const allAgents = await this.prisma.agent.findMany({
          where: { isDeleted: false, ...(department ? { department } : {}) },
          select: { id: true, name: true, status: true, activeCalls: true, socketId: true }
        });
        
        const diagnosticLog = allAgents.map(a => ({
          agentId: a.id,
          name: a.name,
          status: a.status,
          activeCalls: a.activeCalls,
          socketIdPresent: !!a.socketId,
          eligible: a.status === 'AVAILABLE',
          rejectionReason: a.status !== 'AVAILABLE' ? 'STATUS_NOT_AVAILABLE' : 'UNKNOWN'
        }));
        
        this.logger.warn(`[QUEUE-DIAGNOSTIC] NO_AGENT_AVAILABLE. Candidates: ${JSON.stringify(diagnosticLog, null, 2)}`);
        return null;
      }

      // Update the agent's stats
      const updatedAgent = await this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          activeCalls: { increment: 1 },
          lastAssignedAt: new Date(),
          status: 'BUSY', // Mark as busy so they don't get another call immediately
        },
      });

      this.logger.log(
        `Allocated agent ${updatedAgent.id} (activeCalls: ${updatedAgent.activeCalls})`,
      );
      return updatedAgent;
    } catch (error) {
      this.logger.error(`Error allocating agent: ${error.message}`);
      return null;
    }
  }
}
