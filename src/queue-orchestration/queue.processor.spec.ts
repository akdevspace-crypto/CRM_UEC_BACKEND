import { Test, TestingModule } from '@nestjs/testing';
import { SupportQueueProcessor } from './queue.processor';
import { AgentService } from '../agent/agent.service';
import { Job } from 'bullmq';

describe('SupportQueueProcessor', () => {
  let processor: SupportQueueProcessor;
  let agentService: AgentService;

  const mockAgentService = {
    getAvailableAgentsBySkill: jest.fn(),
    updateAgentStatus: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportQueueProcessor,
        { provide: AgentService, useValue: mockAgentService },
      ],
    }).compile();

    processor = module.get<SupportQueueProcessor>(SupportQueueProcessor);
    agentService = module.get<AgentService>(AgentService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should successfully route a call to an available agent', async () => {
    const mockAgents = [
      { id: 'agent-1', lastActive: Date.now() - 5000 },
      { id: 'agent-2', lastActive: Date.now() - 10000 }, // Agent 2 has been idle longer
    ];

    mockAgentService.getAvailableAgentsBySkill.mockResolvedValue(mockAgents);

    const mockJob = {
      id: 'job-1',
      data: { customerId: 'cust-1' },
    } as unknown as Job;

    const result = await processor.process(mockJob);

    // Should select agent-2 because of Round-Robin (idle longest)
    expect(result.assignedAgentId).toBe('agent-2');
    expect(mockAgentService.updateAgentStatus).toHaveBeenCalledWith(
      'agent-2',
      'BUSY',
    );
  });

  it('should throw an error and requeue if no agents are available', async () => {
    mockAgentService.getAvailableAgentsBySkill.mockResolvedValue([]);

    const mockJob = {
      id: 'job-2',
      data: { customerId: 'cust-2' },
    } as unknown as Job;

    await expect(processor.process(mockJob)).rejects.toThrow(
      'No agents available - trigger backoff',
    );
    expect(mockAgentService.updateAgentStatus).not.toHaveBeenCalled();
  });
});
