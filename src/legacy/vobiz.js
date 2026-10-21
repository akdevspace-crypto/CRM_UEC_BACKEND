const express = require('express');
const prisma = require('./prisma');

function vobizWebhookRouter(io) {
  const router = express.Router();

  const getBaseUrl = (req) => {
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = Array.isArray(forwardedHost) ? forwardedHost[0] : (forwardedHost || req.get('host'));
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    return `${protocol}://${host}`;
  };

  // 1. Incoming Call Webhook (Customer calls the Vobiz Number)
  router.post('/incoming', async (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`[Vobiz] Incoming call from ${From} to ${To}. CallSid: ${CallSid}`);

    const customer = From ? await prisma.customer.findFirst({ where: { phone: From } }).catch(() => null) : null;
    const isExisting = !!customer;
    const baseUrl = getBaseUrl(req);
    
    if (isExisting) {
      console.log(`Customer ${From} is an existing customer (${customer.name}).`);
      res.status(200).send(`
        <Response>
          <Gather numDigits="1" action="${baseUrl}/api/v1/webhooks/vobiz/ivr/existing">
            <Say>Welcome back to Elderly Care. Press 1 for Billing. Press 2 for Home Care. Press 3 for Mobility. Press 4 for Emergency.</Say>
          </Gather>
        </Response>
      `);
    } else {
      console.log(`Customer ${From} is a new customer.`);
      res.status(200).send(`
        <Response>
          <Gather numDigits="1" action="${baseUrl}/api/v1/webhooks/vobiz/ivr/new">
            <Say>Welcome to Elderly Care. Press 1 for Elderly Care Services. Press 2 for Home Service. Press 3 for Consultation.</Say>
          </Gather>
        </Response>
      `);
    }
  });

  // 2. IVR Choice Webhook - Existing Customer
  router.post('/ivr/existing', async (req, res) => {
    const { CallSid, From, Digits } = req.body;
    
    let queueName = 'support';
    let priority = 3;

    switch(Digits) {
      case '1': queueName = 'billing'; break;
      case '2': queueName = 'home_care'; break;
      case '3': queueName = 'mobility'; break;
      case '4': 
        queueName = 'emergency'; 
        priority = 1; 
        break;
      default: queueName = 'support';
    }

    console.log(`Call ${CallSid} routing to ${queueName} queue with priority ${priority}`);

    // Enqueue the call into the Enterprise ACD Queue
    try {
      const { enqueueCall } = require('./queues/acdProcessor');
      await enqueueCall({
        callSid: CallSid,
        phone: From,
        queue: queueName,
        priority: priority === 1 ? 'HIGH' : 'NORMAL'
      });
    } catch (e) {
      console.warn('[Vobiz] Enqueue warning:', e.message);
    }

    if (priority === 1) {
      io.emit('emergency_alert', { CallSid, From, message: 'EMERGENCY CALL INCOMING' });
    }

    // Connect to WebRTC SIP Endpoint or dial available agent
    const agent = await prisma.agent.findFirst({
      where: {
        status: 'AVAILABLE',
        department: { equals: queueName, mode: 'insensitive' }
      }
    }).catch(() => null);

    const sipDestination = agent?.email || agent?.id ? `${agent.email || agent.id}@vobiz.in` : `queue_${queueName}@vobiz.in`;

    res.status(200).send(`
      <Response>
        <Say>Please wait while we connect your call.</Say>
        <Dial>
           <User>${sipDestination}</User>
        </Dial>
      </Response>
    `);
  });

  return router;
}

module.exports = { vobizWebhookRouter };
