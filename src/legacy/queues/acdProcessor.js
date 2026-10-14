const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');

// Setup Redis Connection
const redisOptions = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null // Required by BullMQ
};

const connection = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null }) : new Redis(redisOptions);

connection.on('error', (err) => {
  console.error('[Redis ACD] Error:', err.message);
});

// ACD Queue Initialization
const acdQueue = new Queue('acd-queue', { connection });

// Function to add incoming calls to the ACD Queue
async function enqueueCall(callData) {
  console.log(`[ACD] Enqueuing call: ${callData.callSid}`);
  // Add job to queue. Priority 1 = Highest, 2 = Normal
  await acdQueue.add('route-call', callData, {
    priority: callData.priority === 'HIGH' ? 1 : 2,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  });
}

// Global Agent State Accessor
// Fetches all agents from Redis matching the active agent keys
async function getAvailableAgents() {
  const keys = await connection.keys('agent:*');
  if (keys.length === 0) return [];
  
  const agentsData = await connection.mget(keys);
  const availableAgents = [];
  
  for (let i = 0; i < agentsData.length; i++) {
    if (agentsData[i]) {
      const agent = JSON.parse(agentsData[i]);
      if (agent.status === 'AVAILABLE') {
        availableAgents.push([agent.agentId, agent]);
      }
    }
  }
  return availableAgents;
}

// ACD Worker Logic
const acdWorker = new Worker('acd-queue', async (job) => {
  const callData = job.data;
  console.log(`[ACD] Processing Call Routing for ${callData.callSid}...`);

  // 1. Filter available agents (Longest Idle or Round Robin)
  const availableAgents = await getAvailableAgents();

  if (availableAgents.length === 0) {
    // No agents available, throw error to trigger BullMQ retry backoff
    console.log(`[ACD] No agents available for ${callData.callSid}. Re-queuing...`);
    throw new Error('No agents available');
  }

  // 2. Select Agent (Simple Round Robin or First Available for now)
  // In Enterprise, sort by Longest Idle (data.lastStatusChange)
  const [selectedAgentId, agentData] = availableAgents[0];

  console.log(`[ACD] Agent ${selectedAgentId} selected for Call ${callData.callSid}`);
  
  // 3. Emit exact event to the specific agent via Redis PubSub or global io
  const io = require('../index').getIo ? require('../index').getIo() : null;
  if (io && agentData.socketId) {
    io.to(agentData.socketId).emit('incomingCall', callData);
    
    // Set agent to BUSY (Ringing) to avoid dual-allocation
    agentData.status = 'BUSY';
    // Redis keys are stored by socketId. We need to find the specific key, but agentData might hold it or we search.
    // In this simple setup, we'll assume the key is agent:${agentData.socketId} (as used in signaling.js)
    await connection.set(`agent:${agentData.socketId}`, JSON.stringify(agentData));
  }

  return { assignedAgent: selectedAgentId };
}, { connection });

acdWorker.on('completed', (job, returnvalue) => {
  console.log(`[ACD] Job ${job.id} routed successfully to ${returnvalue.assignedAgent}`);
});

acdWorker.on('failed', (job, err) => {
  console.error(`[ACD] Job ${job.id} failed:`, err.message);
});

module.exports = {
  acdQueue,
  enqueueCall
};
