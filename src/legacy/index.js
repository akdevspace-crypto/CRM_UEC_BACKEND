// Intercept console.warn to suppress node-cron missed execution warnings (e.g., when the PC wakes up from sleep)
const originalConsoleWarn = console.warn;
console.warn = function (message, ...args) {
  if (typeof message === 'string' && message.includes('[NODE-CRON]') && message.includes('missed execution')) {
    return;
  }
  originalConsoleWarn(message, ...args);
};

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();
const { setupSignaling } = require('./signaling');
const { vobizWebhookRouter } = require('./vobiz');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Vobiz sends form-urlencoded usually


const mountLegacyApp = (app, io) => {
  app.set("io", io);

const prisma = require('./prisma');

const { initMediasoup } = require('./mediasoup');
const { analyzeAndSaveConversation } = require('./ai-gemini');

// Setup WebRTC and Agent Status Signaling
initMediasoup().then(() => {
  setupSignaling(io);
}).catch(console.error);

// Setup Email Imap Listener
const { startEmailListener } = require('./email');
startEmailListener(io);

// Setup Cron Jobs
const { initCronJobs } = require('./cron');
initCronJobs(io);

// Vobiz Routes
app.use('/api/v1/webhooks/vobiz', vobizWebhookRouter(io));

// Meta Webhook Routes
const metaWebhookRouter = require('./routes/metaWebhook');
app.use('/', metaWebhookRouter);

// Agents Routes
const { requireAuth, requireRole } = require('./middleware/auth');
const agentsRouter = require('./routes/agents');
app.use('/api/v1/agents', requireAuth, agentsRouter);

// Lead Management Routes
const leadsRouter = require('./routes/leads');
const followupsRouter = require('./routes/followups');
app.use('/api/v1/leads', requireAuth, leadsRouter);
app.use('/leads', requireAuth, leadsRouter); // Backward compatibility alias (DEF-05)
app.use('/api/v1/followups', requireAuth, followupsRouter);
app.use('/followups', requireAuth, followupsRouter);

// ==========================================
// FREESWITCH IVR WEBHOOK
// ==========================================
app.post("/webhooks/freeswitch", async (req, res) => {
  console.log("FREESWITCH WEBHOOK RECEIVED");
  console.log(req.body);

  const { caller, digits, callSid, department: inputDept } = req.body;

  let priority = 'NORMAL';
  let department = inputDept || 'general';

  if (digits === '9' || digits === '3') {
    priority = 'HIGH';
    department = 'emergency';
  } else if (digits === '1' || department === 'appointments') {
    department = 'appointments';
  } else if (digits === '4') {
    department = 'care_coordinator';
  } else if (digits === '2') {
    department = 'sales';
  }

  // Find or create customer
  let clientData = null;
  if (caller) {
    clientData = await prisma.customer.findFirst({ where: { phone: caller } });
    if (!clientData) {
      clientData = await prisma.customer.create({ data: { name: 'FreeSWITCH Caller', phone: caller } });
    }
  }

  // Persist conversation history
  let conversation = null;
  if (clientData) {
    // 1. Create Call Log
    await prisma.callLog.create({
      data: {
        customerId: clientData.id,
        vobizCallSid: callSid || 'fs_' + Date.now(),
        status: 'RINGING',
        direction: 'INBOUND'
      }
    });

    // 2. Create Conversation History
    conversation = await prisma.conversation.create({
      data: {
        customerId: clientData.id,
        channel: 'VOICE',
        priority: priority === 'HIGH' ? 'HIGH' : 'NORMAL',
        status: 'OPEN',
        unreadCount: 1
      }
    });

    // 3. Add initial context message
    const msg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: 'SYSTEM',
        content: `📞 Incoming FreeSWITCH Call\nDepartment: ${department}\nUrgency: ${priority}`,
        status: 'DELIVERED'
      }
    });

    // Broadcast to Inbox
    io.emit('conversationUpdated', conversation);
    io.emit('new_message', { conversationId: conversation.id, message: msg });

    // Trigger AI Analysis in background
    analyzeAndSaveConversation(conversation.id, io).catch(console.error);
  }

  const callData = {
    caller: caller || 'Unknown',
    phone: caller || 'Unknown',
    callSid: callSid || 'fs_' + Date.now(),
    customerName: clientData ? clientData.name : 'Unknown Caller',
    urgency: priority,
    category: department,
    emergencyFlag: priority === 'HIGH'
  };

  // Enqueue the call into the Enterprise ACD Queue
  const { enqueueCall } = require('./queues/acdProcessor');
  await enqueueCall({
    callSid: callData.callSid,
    from: callData.phone,
    queue: department,
    priority: priority
  });

  if (priority === 'HIGH') {
    io.emit('emergency_alert', { CallSid: callData.callSid, From: callData.phone, message: 'EMERGENCY CALL INCOMING' });
  }

  broadcastAnalytics();

  res.json({
    success: true
  });
});

// ==========================================
// API ROUTES
// ==========================================

// Auth Routes
const bcrypt = require('bcryptjs');

/* 
app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { agentProfile: true }
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Compare the provided password with the hashed password from DB
    const isValid = await bcrypt.compare(password, user.passwordHash);

    // Also allow raw string if it perfectly matches (for legacy non-hashed accounts)
    if (!isValid && password !== user.passwordHash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = 'jwt_token_mock_until_nestjs_auth_guard_is_setup';
    res.json({
      accessToken: token,
      user: {
        id: user.id,
        agentId: user.agentProfile?.id,
        email: user.email,
        role: user.role,
        name: user.agentProfile?.name || 'Admin',
        department: user.agentProfile?.department || 'General Support',
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error', details: err.message, stack: err.stack });
  }
});
*/

// Dynamic CRM APIs
app.get('/api/v1/conversations', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user.role);
    const whereClause = {};
    if (!isElevated && user) {
      whereClause.OR = [
        { agentId: user.agentId },
        { agentId: user.userId },
        { agentId: user.id },
        { agentId: null }
      ];
    }

    const conversations = await prisma.conversation.findMany({
      where: whereClause,
      include: {
        customer: true,
        messages: { orderBy: { createdAt: 'desc' }, take: 1 }
      },
      orderBy: { updatedAt: 'desc' }
    });

    // Transform to match frontend expectations
    const formatted = conversations.map(c => ({
      id: c.id,
      customerId: c.customer?.id,
      customerName: c.channel === 'INSTAGRAM' && c.customer?.instagramUsername ? c.customer.instagramUsername : (c.customer?.name || 'Unknown'),
      customerAvatar: c.customer?.instagramProfilePic || null,
      customerEmail: c.customer?.email || 'unknown@example.com',
      channel: c.channel.toLowerCase(),
      lastMessage: c.messages[0]?.content || 'No messages',
      unreadCount: c.unreadCount,
      priority: c.priority.toLowerCase(),
      status: c.status.toLowerCase(),
      timestamp: c.updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }));

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database connection failed' });
  }
});

// Fetch Customer Full Profile (Omnichannel Fix Phase 1)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
app.get('/api/v1/customers/:id', requireAuth, async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: {
        notes: { orderBy: { createdAt: 'desc' } },
        tickets: { orderBy: { createdAt: 'desc' }, take: 5 },
        conversations: {
          include: { aiSummary: true },
          orderBy: { createdAt: 'desc' }
        },
        platformIdentities: true
      }
    });

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Find latest AI summary from conversations
    const aiSummary = customer.conversations.find(c => c.aiSummary)?.aiSummary || null;

    res.json({
      ...customer,
      aiSummary
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch customer profile' });
  }
});

// Fetch Customer by Phone
app.get('/api/v1/customers', requireAuth, async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ error: 'Phone parameter is required' });
    }

    let searchPhone = String(phone).replace('whatsapp:', '');

    let customer = await prisma.customer.findFirst({
      where: { phone: searchPhone },
      include: {
        servicePlans: true
      }
    });

    // If exact match fails, try stripping all non-digits and matching the last 10 digits
    if (!customer) {
      const cleanPhone = searchPhone.replace(/\D/g, '');
      if (cleanPhone.length >= 10) {
        const last10 = cleanPhone.slice(-10);
        customer = await prisma.customer.findFirst({
          where: { phone: { endsWith: last10 } },
          include: { servicePlans: true }
        });
      }
    }

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    res.json({ customer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch customer by phone' });
  }
});

// Fetch Directory of Agents (Protected fallback)
app.get('/api/v1/agents', requireAuth, async (req, res) => {
  try {
    const allUsers = await prisma.user.findMany({
      include: { agentProfile: true }
    });

    // Filter in-memory to avoid Prisma enum type errors on non-migrated Supabase databases
    const agents = allUsers.filter(u =>
      ['AGENT', 'ADMIN', 'SUPER_ADMIN', 'SUPERVISOR'].includes(u.role) &&
      u.agentProfile && u.agentProfile.name !== 'Unknown'
    );

    res.json(agents.map(u => ({
      id: u.id,
      email: u.email,
      role: u.role,
      name: u.agentProfile.name,
      department: u.agentProfile.department || 'General',
      status: u.agentProfile.status || 'OFFLINE'
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch directory' });
  }
});

// Send new message
app.post('/api/v1/messages/send', requireAuth, async (req, res) => {
  const { conversationId, content, senderType } = req.body;
  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }
  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }
  try {
    const newMessage = await prisma.message.create({
      data: {
        conversationId,
        content,
        senderType: senderType || 'AGENT',
        status: 'SENT'
      }
    });

    // Broadcast to WebSocket clients
    io.emit('new_message', { conversationId, message: newMessage });
    analyzeAndSaveConversation(conversationId, io).catch(console.error);

    res.json(newMessage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

const { sendEmailReply } = require('./mailer');

// Send actual Email and log it
app.post('/api/messages/send-email', requireAuth, async (req, res) => {
  const { conversationId, customerEmail, subject, message, agentId } = req.body;
  try {
    // 1. Verify conversation
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId }
    });

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    // 2. Format proper Enterprise HTML email
    const htmlBody = `
      <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
        <div style="background-color: #2563eb; padding: 20px; text-align: center;">
          <h2 style="color: white; margin: 0;">ElderCare Services CRM</h2>
        </div>
        <div style="padding: 20px;">
          <p style="white-space: pre-wrap;">${message}</p>
        </div>
        <div style="background-color: #f8fafc; padding: 15px; font-size: 12px; color: #64748b; text-align: center;">
          <p>Reply directly to this email to continue the conversation.</p>
          <p>&copy; ${new Date().getFullYear()} ElderCare Support Team</p>
        </div>
      </div>
    `;

    // 3. Send Email via Nodemailer
    const emailResult = await sendEmailReply(customerEmail, `Re: ${subject || 'Your Support Request'}`, htmlBody, null, null);

    // 4. Save outgoing message to DB
    const newMessage = await prisma.message.create({
      data: {
        conversationId,
        content: message,
        senderType: 'AGENT',
        status: emailResult.success ? 'DELIVERED' : 'FAILED'
      }
    });

    // 5. Store Email Log (Fallback to manual raw query if Prisma client wasn't generated)
    try {
      await prisma.$executeRaw`
        INSERT INTO "EmailLog" (id, "conversationId", "customerEmail", subject, body, status, "messageId", "sentAt")
        VALUES (gen_random_uuid(), ${conversationId}::uuid, ${customerEmail}, ${subject || 'Reply'}, ${message}, ${emailResult.success ? 'SENT' : 'FAILED'}, ${emailResult.messageId || null}, NOW())
      `;
    } catch (logErr) {
      console.error('Failed to write to EmailLog table:', logErr);
    }

    // 6. Emit real-time Socket.IO event
    io.emit('new_message', { conversationId, message: newMessage });
    io.emit('messageSent', { conversationId, status: emailResult.success ? 'Success' : 'Failed' });
    analyzeAndSaveConversation(conversationId, io).catch(console.error);

    res.json({ success: emailResult.success, message: newMessage });
  } catch (err) {
    console.error('Email API Error:', err);
    res.status(500).json({ error: 'Failed to process email' });
  }
});

// TWILIO WHATSAPP WEBHOOK
app.post("/webhooks/existing-customer", async (req, res) => {
  console.log("EXISTING CUSTOMER WEBHOOK");
  console.log(req.body);
  await handleVobizPassthru(req, res, "existing_customer", "NORMAL", "incomingCall");
});

// ==========================================
// SIGNALWIRE AI VOICE AGENT WEBHOOK
// ==========================================
app.post("/webhooks/signalwire", async (req, res) => {
  console.log("SIGNALWIRE WEBHOOK RECEIVED");
  console.log(req.body);

  const { caller, transcript, conversation } = req.body;

  // Basic priority detection from transcript
  let priority = 'NORMAL';
  const lowerTranscript = transcript?.toLowerCase() || '';
  if (lowerTranscript.includes('emergency') || lowerTranscript.includes('urgent')) {
    priority = 'HIGH';
  }

  // Determine department
  let department = 'general';
  if (lowerTranscript.includes('appointment')) department = 'appointments';
  else if (lowerTranscript.includes('home care') || lowerTranscript.includes('pricing')) department = 'sales';

  // Find or create customer
  let customer = null;
  if (caller) {
    customer = await prisma.customer.findFirst({ where: { phone: caller } });
    if (!customer) {
      customer = await prisma.customer.create({ data: { name: 'SignalWire Caller', phone: caller } });
    }
  }

  // Create queue and call log
  if (customer) {
    await prisma.queueItem.create({
      data: {
        customerId: customer.id,
        department: department,
        priority: priority === 'HIGH' ? 'HIGH' : 'NORMAL',
        status: 'WAITING'
      }
    });

    await prisma.callLog.create({
      data: {
        customerId: customer.id,
        vobizCallSid: conversation || 'signalwire_' + Date.now(),
        status: 'RINGING',
        direction: 'INBOUND'
      }
    });
  }

  const callData = {
    caller: caller || 'Unknown',
    phone: caller || 'Unknown',
    transcript: transcript || '',
    conversation: conversation || '',
    callSid: conversation || 'signalwire_' + Date.now(),
    customerName: customer ? customer.name : 'Unknown Caller',
    urgency: priority,
    category: department,
    emergencyFlag: priority === 'HIGH'
  };

  // Enqueue the call into the Enterprise ACD Queue
  const { enqueueCall } = require('./queues/acdProcessor');
  await enqueueCall({
    callSid: callData.callSid,
    from: callData.phone,
    queue: department,
    priority: priority
  });

  if (priority === 'HIGH') {
    io.emit('emergency_alert', { CallSid: callData.callSid, From: callData.phone, message: 'EMERGENCY AI CALL INCOMING' });
  }

  broadcastAnalytics();

  res.json({
    success: true
  });
});

app.post('/webhooks/whatsapp', async (req, res) => {
  console.log("WHATSAPP MESSAGE RECEIVED");

  const fromNumber = req.body.From; // format: 'whatsapp:+1234567890'
  const bodyText = req.body.Body;
  const profileName = req.body.ProfileName || 'WhatsApp User';

  const messageData = {
    from: fromNumber,
    body: bodyText,
    profile: profileName,
    timestamp: new Date(),
  };
  console.log(messageData);

  try {
    // 1. Find or create Customer
    let customer = await prisma.customer.findFirst({ where: { phone: fromNumber } });
    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          name: profileName,
          phone: fromNumber,
        }
      });
    }

    // 2. Find open conversation or create new one
    let conversation = await prisma.conversation.findFirst({
      where: { customerId: customer.id, channel: 'WHATSAPP', status: 'OPEN' }
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          customerId: customer.id,
          channel: 'WHATSAPP',
          priority: 'NORMAL',
          unreadCount: 0
        }
      });
    }

    // 3. Save incoming message
    const savedMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: 'CUSTOMER',
        content: bodyText,
        status: 'DELIVERED'
      }
    });

    // 4. Update conversation unread count
    const updatedConv = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { unreadCount: { increment: 1 }, updatedAt: new Date() },
      include: { customer: true }
    });

    // 5. Broadcast to CRM UI
    // Standard event
    io.emit('new_message', { conversationId: conversation.id, message: savedMessage });
    analyzeAndSaveConversation(conversation.id, io).catch(console.error);

    // Requested specific event for WhatsApp
    io.emit('newWhatsAppMessage', {
      conversation: updatedConv,
      message: savedMessage,
      customer: customer
    });

    io.emit('conversationUpdated', updatedConv);
    io.emit('unreadUpdated', { conversationId: conversation.id, unreadCount: updatedConv.unreadCount });

  } catch (err) {
    console.error('Failed to process WhatsApp message:', err);
  }

  res.sendStatus(200);
});

// TWILIO CLIENT CONFIGURATION
const twilio = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';

// OUTGOING WHATSAPP
app.post('/api/messages/send-whatsapp', requireAuth, async (req, res) => {
  const { conversationId, message } = req.body;
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { customer: true }
    });

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const customerPhone = conversation.customer.phone;
    if (!customerPhone) return res.status(400).json({ error: 'Customer phone number missing' });

    // Ensure proper WhatsApp formatting
    const formattedTo = customerPhone.startsWith('whatsapp:') ? customerPhone : `whatsapp:${customerPhone}`;

    // 1. Send via Twilio
    const twilioResponse = await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: formattedTo,
      body: message
    });

    console.log('✅ Twilio WhatsApp Sent:', twilioResponse.sid);

    // 2. Save outgoing message to DB
    const savedMessage = await prisma.message.create({
      data: {
        conversationId,
        content: message,
        senderType: 'AGENT',
        status: 'DELIVERED' // Simplification; Twilio gives queued/sent/delivered via webhooks
      }
    });

    // 3. Save to WhatsappLog (Raw SQL to prevent missing Prisma client typing)
    try {
      await prisma.$executeRaw`
        INSERT INTO "WhatsappLog" (id, "conversationId", phone, message, direction, status, "twilioSid", "createdAt")
        VALUES (gen_random_uuid(), ${conversationId}::uuid, ${formattedTo}, ${message}, 'OUTBOUND', 'SENT', ${twilioResponse.sid}, NOW())
      `;
    } catch (logErr) {
      console.error('Failed to log WhatsApp:', logErr);
    }

    // 4. Broadcast
    io.emit('new_message', { conversationId, message: savedMessage });
    io.emit('messageSent', { conversationId, status: 'Success' });
    io.emit('conversationUpdated', conversation);
    analyzeAndSaveConversation(conversationId, io).catch(console.error);

    res.json({ success: true, message: savedMessage });
  } catch (err) {
    console.error('❌ Twilio Send Error:', err);
    res.status(500).json({ error: 'Failed to send WhatsApp message', details: err.message });
  }
});

// TEST ROUTE (Restricted to Super Admin)
app.get('/test-send', requireAuth, requireRole(['SUPER_ADMIN']), async (req, res) => {
  try {
    // For test, you can dynamically read from query string or use hardcoded if none provided
    // example: /test-send?to=+91xxxxxx
    const toNum = req.query.to || '+15551234567';
    const formattedTo = toNum.startsWith('whatsapp:') ? toNum : `whatsapp:${toNum}`;

    const twilioResponse = await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: formattedTo,
      body: "Test message from ElderCare CRM"
    });

    res.json({ success: true, sid: twilioResponse.sid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// OUTGOING INSTAGRAM
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || '';

app.post('/api/messages/send-instagram', requireAuth, async (req, res) => {
  const { conversationId, message } = req.body;
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { customer: true }
    });

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const customerIgId = conversation.customer.phone; // We stored the IG senderId in phone

    // 1. Send via Instagram Graph API
    const igResponse = await fetch('https://graph.instagram.com/v21.0/me/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${IG_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        recipient: { id: customerIgId },
        message: { text: message }
      })
    });

    const igData = await igResponse.json();

    if (!igResponse.ok) {
      console.error('Instagram API Error:', igData);
      throw new Error(igData.error?.message || 'Failed to send Instagram message');
    }

    console.log('✅ Instagram Message Sent:', igData.message_id);

    // 2. Save outgoing message to DB
    const savedMessage = await prisma.message.create({
      data: {
        conversationId,
        content: message,
        senderType: 'AGENT',
        status: 'DELIVERED'
      }
    });

    // 3. Broadcast
    io.emit('new_message', { conversationId, message: savedMessage });
    io.emit('messageSent', { conversationId, status: 'Success' });
    analyzeAndSaveConversation(conversationId, io).catch(console.error);

    // Update unread and timestamp
    const updatedConv = await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
      include: { customer: true }
    });
    io.emit('conversationUpdated', updatedConv);

    res.json({ success: true, message: savedMessage });
  } catch (err) {
    console.error('❌ Instagram Send Error:', err);
    res.status(500).json({ error: 'Failed to send Instagram message', details: err.message });
  }
});

// Fetch messages for a specific conversation
app.get('/api/v1/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: req.params.id },
    });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const user = req.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user.role);
    if (!isElevated && user && conversation.agentId && conversation.agentId !== user.agentId && conversation.agentId !== user.userId) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions to access this conversation' });
    }

    const messages = await prisma.message.findMany({
      where: { conversationId: req.params.id },
      orderBy: { createdAt: 'asc' }
    });

    const formatted = messages.map(m => ({
      id: m.id,
      sender: m.senderType.toLowerCase(),
      content: m.content,
      timestamp: m.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: m.status.toLowerCase(),
      aiSuggested: m.isAiSuggested
    }));

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Mark conversation as read
app.put('/api/v1/conversations/:id/read', requireAuth, async (req, res) => {
  try {
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const updatedConv = await prisma.conversation.update({
      where: { id: req.params.id },
      data: { unreadCount: 0 }
    });

    // Broadcast unread update
    io.emit('unreadUpdated', { conversationId: updatedConv.id, unreadCount: 0 });

    res.json({ success: true });
  } catch (err) {
    console.error('Error marking conversation as read:', err);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// Fetch AI Call Records (Call Logs with AI Summaries)
app.get('/api/v1/call-records', requireAuth, async (req, res) => {
  try {
    const role = req.user?.role;
    const agentId = req.user?.agentId || req.user?.userId;

    const whereClause = {};

    const isElevated = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(role);
    if (!isElevated) {
      // Admins and Managers see all; regular agents only see OUTBOUND calls assigned to them
      whereClause.direction = 'OUTBOUND';
      if (agentId) {
        whereClause.agentId = agentId;
      }
    }

    const callLogs = await prisma.callLog.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: true,
        agent: true
      }
    });

    const enrichedLogs = await Promise.all(callLogs.map(async (log) => {
      // Find associated CustomerNote that contains the AI Summary for this callSid
      let aiSummaryStr = null;
      if (log.vobizCallSid) {
        const note = await prisma.customerNote.findFirst({
          where: {
            customerId: log.customerId,
            content: { startsWith: `[Call: ${log.vobizCallSid}]` }
          }
        });
        if (note) {
          try {
            aiSummaryStr = JSON.parse(note.content.split('AI Call Summary: ')[1] || "{}");
          } catch (e) { }
        }
      }
      return {
        id: log.id,
        direction: log.direction || 'INBOUND',
        customerName: log.customer?.name || 'Unknown',
        customerPhone: log.customer?.phone || 'Unknown',
        agentName: log.agent?.name || 'Unassigned',
        duration: log.duration,
        status: log.status,
        recordingUrl: log.recordingUrl,
        timestamp: log.createdAt,
        aiSummary: aiSummaryStr
      };
    }));

    res.json(enrichedLogs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch call records' });
  }
});

// End Call Endpoint
app.post('/api/v1/calls/:sid/end', requireAuth, async (req, res) => {
  const { sid } = req.params;
  const { duration, transcript, recordingUrl, conversationId, customerId, agentId } = req.body;

  try {
    // 1. Update the Call Log
    await prisma.callLog.updateMany({
      where: { vobizCallSid: sid },
      data: {
        status: 'COMPLETED',
        endedAt: new Date(),
        duration,
        recordingUrl
      }
    });

    const callRecord = await prisma.callLog.findFirst({ where: { vobizCallSid: sid } });

    // 2. Broadcast call completion to analytics
    broadcastAnalytics();

    // 3. AI Analysis
    const { generateCallSummary } = require('./ai');
    let aiResult = null;
    if (transcript) {
      aiResult = await generateCallSummary(transcript);
      console.log(`[AI Analysis] Call ${sid} Sentiment: ${aiResult.sentiment}`);

      // Update CallLog with AI data
      await prisma.callLog.updateMany({
        where: { vobizCallSid: sid },
        data: {
          notes: JSON.stringify(aiResult)
        }
      });
    }

    // 4. Evaluate Workflows!
    const { evaluateTriggers } = require('./workflows/workflowEngine');
    await evaluateTriggers('CALL_COMPLETED', {
      callSid: sid,
      customerId: callRecord?.customerId || customerId,
      transcript,
      recordingUrl,
      aiAnalysis: aiResult
    });

    // 5. Native AI Escalation (If workflow engine doesn't catch it)
    if (aiResult?.sentiment === 'NEGATIVE' || aiResult?.escalationRisk === 'HIGH') {
      await evaluateTriggers('NEGATIVE_SENTIMENT', {
        callSid: sid,
        customerId: callRecord?.customerId || customerId,
        reason: aiResult.summary
      });
    }

    io.emit('callEnded', { sid, duration, summary: aiResult });
    res.json({ success: true, aiSummary: aiResult });
  } catch (err) {
    console.error('Error ending call:', err);
    res.status(500).json({ error: 'Failed to end call' });
  }
});

// ==========================================
// CALL LOGIC & AI SUMMARY
// ==========================================

app.get('/api/v1/calls/records', requireAuth, async (req, res) => {
  try {
    const role = req.user?.role;
    const agentId = req.user?.agentId || req.user?.userId;

    const whereClause = {};

    const isElevated = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(role);
    if (!isElevated) {
      // Regular agent: ONLY outbound calls attended by them
      whereClause.direction = 'OUTBOUND';
      if (agentId) {
        whereClause.agentId = agentId;
      }
    }

    const callLogs = await prisma.callLog.findMany({
      where: whereClause,
      include: {
        customer: {
          include: { notes: true }
        },
        agent: true
      },
      orderBy: { createdAt: 'desc' }
    });

    // We fetch AiSummary from conversation notes manually if we need to
    const formatted = callLogs.map(log => {
      const aiNote = log.customer?.notes?.find(n => n.content.includes(`[Call: ${log.vobizCallSid}]`));
      let aiSummary = null;
      if (aiNote) {
        try {
          aiSummary = JSON.parse(aiNote.content.replace(`[Call: ${log.vobizCallSid}] AI Call Summary: `, ''));
        } catch (e) { }
      }

      return {
        id: log.id,
        callSid: log.vobizCallSid,
        customerName: log.customer?.name || 'Unknown',
        customerPhone: log.customer?.phone || 'Unknown',
        agentName: log.agent?.name || 'Unassigned',
        status: log.status,
        duration: log.duration,
        recordingUrl: log.recordingUrl,
        date: log.createdAt,
        direction: (log.agentId) ? 'Outbound' : 'Inbound',
        aiSummary
      };
    });

    res.json({ success: true, records: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch call records' });
  }
});

// ==========================================
// TICKETING API
// ==========================================

// Short-lived query cache with single-flight de-duplication to prevent DB pool exhaustion under high concurrency
const ticketsDbCache = new Map();
const inFlightTicketsQueries = new Map();
const TICKETS_CACHE_TTL = 3000; // 3 seconds

function invalidateTicketsCache() {
  ticketsDbCache.clear();
}

app.get('/api/v1/tickets', requireAuth, async (req, res) => {
  try {
    const role = req.user?.role;
    const agentId = req.user?.agentId || req.user?.userId;

    const whereClause = {};
    const isElevated = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(role);
    if (!isElevated && agentId) {
      whereClause.OR = [
        { agentId: agentId },
        { agentId: null }
      ];
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const cacheKey = JSON.stringify({ whereClause, limit });
    const now = Date.now();

    let tickets;
    const cached = ticketsDbCache.get(cacheKey);
    if (cached && (now - cached.timestamp < TICKETS_CACHE_TTL)) {
      tickets = cached.data;
    } else if (inFlightTicketsQueries.has(cacheKey)) {
      tickets = await inFlightTicketsQueries.get(cacheKey);
    } else {
      const fetchPromise = (async () => {
        return await prisma.ticket.findMany({
          where: whereClause,
          select: {
            id: true,
            category: true,
            status: true,
            priority: true,
            updatedAt: true,
            customer: { select: { name: true } },
          },
          orderBy: { updatedAt: 'desc' },
          take: limit,
        });
      })();

      inFlightTicketsQueries.set(cacheKey, fetchPromise);
      try {
        tickets = await fetchPromise;
        ticketsDbCache.set(cacheKey, { data: tickets, timestamp: Date.now() });
      } finally {
        inFlightTicketsQueries.delete(cacheKey);
      }
    }

    res.json(tickets.map(t => ({
      id: t.id,
      customer: t.customer?.name || 'Unknown',
      subject: t.category,
      status: t.status,
      priority: t.priority,
      updated: (t.updatedAt instanceof Date ? t.updatedAt : new Date(t.updatedAt)).toLocaleDateString()
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

app.post('/api/v1/tickets', requireAuth, async (req, res) => {
  const { customerPhone, customerName, subject, description, priority, category, agentId } = req.body;
  try {
    let customer = await prisma.customer.findUnique({ where: { phone: customerPhone } });
    if (!customer) {
      customer = await prisma.customer.create({ data: { name: customerName, phone: customerPhone } });
    }

    const isElevated = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(req.user?.role);
    let assignedAgentId = (isElevated && agentId) ? agentId : (req.user?.agentId || null);
    const ticketCategory = category || subject;

    // Intelligent Routing by Department
    if (!assignedAgentId && ticketCategory) {
      const availableAgents = await prisma.agent.findMany({
        where: {
          status: 'AVAILABLE',
          department: { equals: ticketCategory, mode: 'insensitive' }
        },
        include: {
          _count: {
            select: { assignedTickets: { where: { status: 'OPEN' } } }
          }
        }
      });

      if (availableAgents.length > 0) {
        // Load balance: agent with fewest open tickets
        availableAgents.sort((a, b) => a._count.assignedTickets - b._count.assignedTickets);
        assignedAgentId = availableAgents[0].id;
      }
    }

    const ticket = await prisma.ticket.create({
      data: {
        customerId: customer.id,
        category: ticketCategory,
        priority: priority || 'NORMAL',
        status: 'OPEN',
        resolution: description,
        agentId: assignedAgentId
      },
      include: {
        agent: true,
        customer: true
      }
    });

    invalidateTicketsCache();
    io.emit('ticketCreated', ticket);
    io.emit('admin_ticket_alert', ticket);

    res.json(ticket);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// Update Ticket Status
app.put('/api/v1/tickets/:id/status', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status, resolution } = req.body;
  try {
    const updated = await prisma.ticket.update({
      where: { id },
      data: {
        status: status || undefined,
        resolution: resolution || undefined,
        resolvedAt: (status === 'RESOLVED' || status === 'CLOSED') ? new Date() : undefined,
      },
      include: { customer: true, agent: true }
    });
    invalidateTicketsCache();
    io.emit('ticketUpdated', updated);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update ticket status' });
  }
});

// ==========================================
// CALENDAR & APPOINTMENTS (DEF-07 / DEF-08)
// ==========================================
const calendarDbCache = new Map();
const inFlightCalendarQueries = new Map();
const CALENDAR_CACHE_TTL = 3000; // 3 seconds

function invalidateCalendarCache() {
  calendarDbCache.clear();
}

const handleCalendarRequest = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const now = new Date();
    const start = startDate ? new Date(startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = endDate ? new Date(endDate) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);

    const cacheKey = `${start.toISOString()}_${end.toISOString()}_${limit}`;
    const cacheNow = Date.now();

    let appointments;
    const cached = calendarDbCache.get(cacheKey);
    if (cached && (cacheNow - cached.timestamp < CALENDAR_CACHE_TTL)) {
      appointments = cached.data;
    } else if (inFlightCalendarQueries.has(cacheKey)) {
      appointments = await inFlightCalendarQueries.get(cacheKey);
    } else {
      const fetchPromise = (async () => {
        return await prisma.appointment.findMany({
          where: {
            startTime: {
              gte: start,
              lte: end,
            },
          },
          include: {
            customer: {
              select: { id: true, name: true, phone: true }
            },
            doctor: {
              select: { id: true, name: true, department: true }
            }
          },
          orderBy: { startTime: 'asc' },
          take: limit,
        });
      })();

      inFlightCalendarQueries.set(cacheKey, fetchPromise);
      try {
        appointments = await fetchPromise;
        calendarDbCache.set(cacheKey, { data: appointments, timestamp: Date.now() });
      } finally {
        inFlightCalendarQueries.delete(cacheKey);
      }
    }

    res.json(appointments);
  } catch (err) {
    console.error('[Calendar] Error:', err);
    res.status(500).json({ error: 'Failed to fetch calendar appointments' });
  }
};

app.get('/calendar', requireAuth, handleCalendarRequest);
app.get('/api/v1/appointments/calendar', requireAuth, handleCalendarRequest);

// ==========================================
// DASHBOARD ANALYTICS API (DEF-06)
// ==========================================
let legacyInFlightRawMetrics = null;
let legacyCachedRawMetrics = null;
const ANALYTICS_CACHE_TTL = 15000; // 15 seconds

const getLegacyRawMetrics = async () => {
  const now = Date.now();
  if (legacyCachedRawMetrics && (now - legacyCachedRawMetrics.timestamp < ANALYTICS_CACHE_TTL)) {
    return legacyCachedRawMetrics.data;
  }
  if (legacyInFlightRawMetrics) {
    return legacyInFlightRawMetrics;
  }

  legacyInFlightRawMetrics = (async () => {
    try {
      const [countsResult, servicesResult] = await Promise.all([
        prisma.$queryRaw`
          SELECT
            (SELECT COUNT(*)::int FROM "Customer") as total_customers,
            (SELECT COUNT(*)::int FROM "Lead") as total_leads,
            (SELECT COUNT(*)::int FROM "Lead" WHERE status IN ('NEW', 'IN_PROGRESS')) as active_leads,
            (SELECT COUNT(*)::int FROM "Lead" WHERE status IN ('CONVERTED', 'POSITIVE')) as converted_leads,
            (SELECT COUNT(*)::int FROM "Lead" WHERE sentiment = 'POSITIVE') as positive_leads,
            (SELECT COUNT(*)::int FROM "CallSession") as total_calls,
            (SELECT COUNT(*)::int FROM "CallSession" WHERE status = 'IN_PROGRESS') as active_calls,
            (SELECT COUNT(*)::int FROM "Agent") as total_agents,
            (SELECT COUNT(*)::int FROM "Agent" WHERE status = 'AVAILABLE') as available_agents,
            (SELECT COUNT(*)::int FROM "QueueItem" WHERE status = 'WAITING') as waiting_queue,
            (SELECT COALESCE(AVG(duration), 0)::float FROM "CallSession") as avg_duration;
        `.catch(err => {
          console.warn('[Legacy Analytics] queryRaw fallback:', err.message);
          return null;
        }),
        prisma.lead.groupBy({
          by: ['serviceInterest'],
          _count: { id: true }
        }).catch(() => [])
      ]);

      let raw;
      if (countsResult && countsResult.length > 0) {
        const c = countsResult[0];
        raw = {
          totalCustomers: Number(c.total_customers) || 0,
          totalLeads: Number(c.total_leads) || 0,
          activeLeads: Number(c.active_leads) || 0,
          convertedLeads: Number(c.converted_leads) || 0,
          positiveLeads: Number(c.positive_leads) || 0,
          totalCalls: Number(c.total_calls) || 0,
          activeCalls: Number(c.active_calls) || 0,
          totalAgents: Number(c.total_agents) || 0,
          availableAgents: Number(c.available_agents) || 0,
          waitingQueue: Number(c.waiting_queue) || 0,
          avgDurationSec: Math.round(Number(c.avg_duration) || 0),
          servicesCount: servicesResult || []
        };
      } else {
        const [
          totalCustomers,
          totalLeads,
          activeLeads,
          convertedLeads,
          positiveLeads,
          totalCalls,
          activeCalls,
          totalAgents,
          availableAgents,
          waitingQueue,
          callDurationAgg
        ] = await Promise.all([
          prisma.customer.count().catch(() => 0),
          prisma.lead.count().catch(() => 0),
          prisma.lead.count({ where: { status: { in: ['NEW', 'IN_PROGRESS'] } } }).catch(() => 0),
          prisma.lead.count({ where: { status: { in: ['CONVERTED', 'POSITIVE'] } } }).catch(() => 0),
          prisma.lead.count({ where: { sentiment: 'POSITIVE' } }).catch(() => 0),
          prisma.callSession.count().catch(() => 0),
          prisma.callSession.count({ where: { status: 'IN_PROGRESS' } }).catch(() => 0),
          prisma.agent.count().catch(() => 0),
          prisma.agent.count({ where: { status: 'AVAILABLE' } }).catch(() => 0),
          prisma.queueItem.count({ where: { status: 'WAITING' } }).catch(() => 0),
          prisma.callSession.aggregate({ _avg: { duration: true } }).catch(() => ({ _avg: { duration: 0 } }))
        ]);
        raw = {
          totalCustomers,
          totalLeads,
          activeLeads,
          convertedLeads,
          positiveLeads,
          totalCalls,
          activeCalls,
          totalAgents,
          availableAgents,
          waitingQueue,
          avgDurationSec: Math.round(callDurationAgg?._avg?.duration || 0),
          servicesCount: servicesResult || []
        };
      }

      legacyCachedRawMetrics = {
        timestamp: Date.now(),
        data: raw
      };
      return raw;
    } finally {
      legacyInFlightRawMetrics = null;
    }
  })();

  return legacyInFlightRawMetrics;
};

const handleDashboardAnalytics = async (req, res) => {
  try {
    const { type = 'overall' } = req.query;
    const raw = await getLegacyRawMetrics();
    const {
      totalCustomers,
      totalLeads,
      activeLeads,
      convertedLeads,
      positiveLeads,
      totalCalls,
      activeCalls,
      totalAgents,
      availableAgents,
      waitingQueue,
      servicesCount,
      avgDurationSec
    } = raw;

    const conversionRate = totalLeads > 0 ? ((convertedLeads / totalLeads) * 100).toFixed(1) : '0';
    const avgDurationFormatted = `${Math.floor(avgDurationSec / 60)}m ${avgDurationSec % 60}s`;

    let kpis = [];
    if (type === 'sales_lead') {
      kpis = [
        { label: 'New Leads', value: String(activeLeads), change: '+12.4%', isPositive: true },
        { label: 'Qualified Leads', value: String(positiveLeads), change: '+11.2%', isPositive: true },
        { label: 'Won Deals', value: String(convertedLeads), change: '+9.4%', isPositive: true },
        { label: 'Total Ingested', value: String(totalLeads), change: 'On Track', isPositive: true },
        { label: 'Conversion Rate', value: `${conversionRate}%`, change: '+3.1%', isPositive: true },
        { label: 'Forecasted Revenue', value: `$${(convertedLeads * 1250).toLocaleString()}`, change: 'On Track', isPositive: true },
      ];
    } else if (type === 'agent_performance') {
      kpis = [
        { label: 'Total Calls Handled', value: String(totalCalls), change: '+12.4%', isPositive: true },
        { label: 'Avg Talk Time', value: avgDurationFormatted, change: 'Optimal', isPositive: true },
        { label: 'SLA Compliance', value: '96.2%', change: '+1.5%', isPositive: true },
        { label: 'Available Agents', value: String(availableAgents), change: 'Optimal', isPositive: true },
      ];
    } else if (type === 'contact_center') {
      kpis = [
        { label: 'Live Active Calls', value: String(activeCalls), change: 'Live', isPositive: true },
        { label: 'Waiting in Queue', value: String(waitingQueue), change: 'Live', isPositive: true },
        { label: 'Available Agents', value: String(availableAgents), change: 'Live', isPositive: true },
      ];
    } else {
      kpis = [
        { label: 'Total Customers', value: String(totalCustomers), change: '+4.3%', isPositive: true },
        { label: 'Active Leads Pool', value: String(activeLeads), change: '+12.4%', isPositive: true },
        { label: 'Conversion Rate', value: `${conversionRate}%`, change: '+3.1%', isPositive: true },
        { label: 'Pipeline Deals', value: String(totalLeads), change: '+14.2%', isPositive: true },
      ];
    }

    const sourceShare = servicesCount.length > 0
      ? servicesCount.map(s => ({ name: s.serviceInterest || 'General', value: s._count.id }))
      : [
          { name: 'Direct Inbound', value: totalCalls || 1 },
          { name: 'Website Forms', value: activeLeads || 1 },
        ];

    const salesFunnel = [
      { stage: 'Total Ingested', count: totalLeads },
      { stage: 'Contacted', count: activeLeads + convertedLeads },
      { stage: 'Qualified', count: positiveLeads },
      { stage: 'Converted', count: convertedLeads },
    ];

    const pipelineTrend = [
      { period: 'Week 1', count: Math.ceil(totalLeads * 0.2) },
      { period: 'Week 2', count: Math.ceil(totalLeads * 0.3) },
      { period: 'Week 3', count: Math.ceil(totalLeads * 0.25) },
      { period: 'Week 4', count: Math.ceil(totalLeads * 0.25) },
    ];

    const revenueTrend = [
      { month: 'Jan', revenue: Math.ceil(convertedLeads * 300) },
      { month: 'Feb', revenue: Math.ceil(convertedLeads * 450) },
      { month: 'Mar', revenue: Math.ceil(convertedLeads * 600) },
      { month: 'Apr', revenue: Math.ceil(convertedLeads * 800) },
    ];

    const responseData = {
      kpis,
      charts: {
        sourceShare,
        salesFunnel,
        pipelineTrend,
        revenueTrend,
        callsPerHour: [
          { hour: '09:00', calls: Math.ceil(totalCalls * 0.15) },
          { hour: '11:00', calls: Math.ceil(totalCalls * 0.30) },
          { hour: '14:00', calls: Math.ceil(totalCalls * 0.25) },
          { hour: '16:00', calls: Math.ceil(totalCalls * 0.20) },
          { hour: '18:00', calls: Math.ceil(totalCalls * 0.10) },
        ]
      },
      liveStats: {
        activeCalls,
        waitingQueue,
        availableAgents,
        totalCustomers,
        totalLeads,
        conversionRate
      }
    };

    res.json(responseData);
  } catch (err) {
    console.error('[Dashboard Analytics] Error:', err);
    res.status(500).json({ error: 'Failed to aggregate dashboard analytics' });
  }
};

app.get('/dashboard/analytics', requireAuth, handleDashboardAnalytics);
app.get('/api/v1/dashboard/analytics', requireAuth, handleDashboardAnalytics);

// ==========================================
// EMERGENCY ALERTS API (DEF-10 / DEF-11)
// ==========================================
app.get('/api/v1/emergency-alerts', requireAuth, async (req, res) => {
  try {
    const alerts = await prisma.emergencyAlert.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json(alerts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch emergency alerts' });
  }
});

app.post('/api/v1/emergency-alerts', requireAuth, async (req, res) => {
  const { type, description } = req.body;
  try {
    const alert = await prisma.emergencyAlert.create({
      data: {
        type: type || 'PANIC_BUTTON',
        description: description || 'Emergency alert triggered',
        status: 'ACTIVE'
      }
    });
    io.emit('emergency_alert', alert);
    res.json(alert);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create emergency alert' });
  }
});

app.put('/api/v1/emergency-alerts/:id/resolve', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const updated = await prisma.emergencyAlert.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date()
      }
    });
    io.emit('emergency_resolved', updated);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve emergency alert' });
  }
});

// ==========================================
// WORKFLOW AUTOMATIONS API (DEF-10)
// ==========================================
app.get('/api/v1/automations', requireAuth, async (req, res) => {
  try {
    const workflows = await prisma.workflowAutomation.findMany({
      include: {
        triggers: { orderBy: { createdAt: 'desc' }, take: 5 }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(workflows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch automations' });
  }
});

// ==========================================
// TELEPHONY: CALL TRANSFER (SIP)
// ==========================================
app.post('/api/v1/calls/:sid/transfer', requireAuth, async (req, res) => {
  const { sid } = req.params;
  const { targetAgentId, targetQueue } = req.body;

  console.log(`[Telephony] Transferring call ${sid} to agent ${targetAgentId || targetQueue}`);

  // 1. Emit transfer event to the current WebRTC Room (Signal clients to re-negotiate or switch room)
  io.emit('callTransferred', {
    callSid: sid,
    newAgent: targetAgentId,
    newQueue: targetQueue,
    timestamp: new Date()
  });

  // 2. If transferring to a queue, re-enqueue in BullMQ ACD
  if (targetQueue) {
    const { enqueueCall } = require('./queues/acdProcessor');
    await enqueueCall({
      callSid: sid,
      queue: targetQueue,
      priority: 'HIGH',
      isTransfer: true
    });
  }

  res.json({ success: true, message: 'Call transferred successfully' });
});

// ==========================================
// OMNICHANNEL: META GRAPH API (INSTAGRAM/MESSENGER)
// Moved to src/routes/metaWebhook.js
// ==========================================

// ==========================================
// FEEDBACK API
// ==========================================
app.post('/api/v1/feedback', requireAuth, async (req, res) => {
  const { callSid, csatScore, tags, notes } = req.body;
  const agentId = req.user?.agentId || req.user?.userId;
  try {
    console.log(`Feedback received for call ${callSid} by Agent ${agentId}: CSAT ${csatScore}, Tags: ${Array.isArray(tags) ? tags.join(',') : ''}`);

    // Create customer note representing the feedback for this session
    await prisma.customerNote.create({
      data: {
        content: `Post-Call Feedback: CSAT=${csatScore}/5. Notes: ${notes}. Tags: ${Array.isArray(tags) ? tags.join(', ') : ''}`,
        customerId: "00000000-0000-0000-0000-000000000000",
        agentId: agentId || null
      }
    }).catch(e => console.warn('Could not save feedback note due to missing default customer.'));

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// ==========================================
// REDIS PUB/SUB SUBSCRIBER FOR OMNICHANNEL EVENTS
// ==========================================
const Redis = require('ioredis');
const redisSubscriber = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379
  });

redisSubscriber.subscribe('omnichannel_events', (err, count) => {
  if (err) {
    console.error('[Redis Pub/Sub] Failed to subscribe:', err.message);
  } else {
    console.log(`[Redis Pub/Sub] Subscribed to omnichannel_events. Channel count: ${count}`);
  }
});

redisSubscriber.on('message', (channel, message) => {
  if (channel === 'omnichannel_events') {
    try {
      const event = JSON.parse(message);
      if (event.type === 'instagram_profile_updated') {
        console.log(`[Redis Pub/Sub] Received instagram_profile_updated for customer: ${event.data.customerId}`);
        // Broadcast to WebSocket clients
        io.emit('instagram_profile_updated', event.data);
        io.emit('customer_identity_updated', event.data);
      }
    } catch (err) {
      console.error('[Redis Pub/Sub] Failed to process message:', err.message);
    }
  }
});

};

module.exports = { mountLegacyApp, app };
