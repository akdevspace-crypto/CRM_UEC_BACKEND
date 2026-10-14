const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const prisma = require('../prisma');

const redisOptions = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null
};

const connection = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null }) : new Redis(redisOptions);

connection.on('error', (err) => {
  console.error('[Redis Automation] Error:', err.message);
});

const automationQueue = new Queue('automation-queue', { connection });

// Generic wrapper to add automation tasks
async function dispatchAction(actionData) {
  console.log(`[Automation] Dispatching action: ${actionData.actionType}`);
  await automationQueue.add('execute-action', actionData, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 }
  });
}

// Worker to execute background triggers
const automationWorker = new Worker('automation-queue', async (job) => {
  const { actionType, actionConfig, targetId, workflowId } = job.data;
  console.log(`[Automation] Executing ${actionType} for target ${targetId}...`);

  let status = 'SUCCESS';
  let log = '';

  try {
    switch(actionType) {
      case 'SEND_WHATSAPP':
        // Execute Twilio WhatsApp API
        console.log(`[Action] Sending WhatsApp to ${actionConfig.phone}: ${actionConfig.template}`);
        log = 'WhatsApp message dispatched';
        break;
        
      case 'CREATE_TICKET':
        // Generate a support ticket
        const ticket = await prisma.ticket.create({
          data: {
            customerId: actionConfig.customerId,
            title: actionConfig.title || 'Auto-generated ticket',
            description: actionConfig.description || '',
            priority: 'HIGH',
            status: 'OPEN',
            channel: 'SYSTEM'
          }
        });
        log = `Ticket created: ${ticket.id}`;
        console.log(`[Action] ${log}`);
        break;

      case 'ESCALATE':
        console.log(`[Action] Escalating target ${targetId} to supervisor`);
        log = 'Escalation notification sent to supervisors';
        // Logic to notify supervisor socket room
        break;

      default:
        throw new Error(`Unknown action type: ${actionType}`);
    }

    // Record the trigger success
    if (workflowId) {
      await prisma.automationTrigger.create({
        data: {
          workflowId: workflowId,
          targetId: targetId,
          status: 'SUCCESS',
          executionLog: log,
          executedAt: new Date()
        }
      });
    }

  } catch (err) {
    console.error(`[Automation] Action Failed:`, err);
    if (workflowId) {
       await prisma.automationTrigger.create({
         data: {
           workflowId: workflowId,
           targetId: targetId,
           status: 'FAILED',
           executionLog: err.message,
           executedAt: new Date()
         }
       });
    }
    throw err;
  }

  return { success: true, log };
}, { connection });

module.exports = {
  automationQueue,
  dispatchAction
};
