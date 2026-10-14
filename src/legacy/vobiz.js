const express = require('express');

function vobizWebhookRouter(io) {
  const router = express.Router();

  // 1. Incoming Call Webhook (Customer calls the Vobiz Number)
  router.post('/incoming', async (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`[Vobiz] Incoming call from ${From} to ${To}. CallSid: ${CallSid}`);

    // In a real scenario, we check CRM for the customer 'From' number
    const isExisting = true; // Mock CRM lookup
    
    let ivrResponse = '';
    
    if (isExisting) {
      console.log(`Customer ${From} is an existing customer.`);
      // Return Vobiz TwiML or Passthru instructions for Existing Customer IVR
      // E.g., Press 1 for Billing, 2 for Home Care, 3 for Mobility, 4 for Emergency
      res.status(200).send(`
        <Response>
          <Gather numDigits="1" action="https://your-ngrok-url/api/v1/webhooks/vobiz/ivr/existing">
            <Say>Welcome back to Elderly Care. Press 1 for Billing. Press 2 for Home Care. Press 3 for Mobility. Press 4 for Emergency.</Say>
          </Gather>
        </Response>
      `);
    } else {
      console.log(`Customer ${From} is a new customer.`);
      res.status(200).send(`
        <Response>
          <Gather numDigits="1" action="https://your-ngrok-url/api/v1/webhooks/vobiz/ivr/new">
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
    const { enqueueCall } = require('./queues/acdProcessor');
    await enqueueCall({
      callSid: CallSid,
      phone: From,
      queue: queueName,
      priority: priority === 1 ? 'HIGH' : 'NORMAL'
    });

    if (priority === 1) {
      io.emit('emergency_alert', { CallSid, From, message: 'EMERGENCY CALL INCOMING' });
    }

    // Connect to WebRTC SIP Endpoint or dial agent
    // E.g., Vobiz Applet to connect to agent sip uri
    res.status(200).send(`
      <Response>
        <Say>Please wait while we connect your call.</Say>
        <Dial>
           <!-- Route to WebRTC user -->
           <User>agent1@yourdomain.vobiz.in</User>
        </Dial>
      </Response>
    `);
  });

  return router;
}

module.exports = { vobizWebhookRouter };
