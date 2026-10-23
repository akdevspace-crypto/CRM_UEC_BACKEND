const express = require('express');
const router = express.Router();
const prisma = require('../prisma');
const { enqueueInstagramEnrichment } = require('../queues/instagramEnrichment');
const { analyzeAndSaveConversation } = require('../ai-gemini');
const crypto = require('crypto');
const Redis = require('ioredis');

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'my_instagram_verify_token';

// Connect to Redis for webhook idempotency
const redisConnection = process.env.REDIS_URL 
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null }) 
  : new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
    });

redisConnection.on('error', (err) => {
  console.warn('[Redis Meta Webhook] Warning:', err.message);
});

// GET /webhook - Meta Webhook Verification
router.get(['/webhook', '/webhooks/meta'], (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ META WEBHOOK VERIFIED');
      res.status(200).send(challenge);
    } else {
      console.error('❌ META WEBHOOK VERIFICATION FAILED: Token mismatch');
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// POST /webhook - Meta Event Receiver
router.post(['/webhook', '/webhooks/meta'], async (req, res) => {
  const body = req.body;
  const io = req.app.get('io');

  // Verify HMAC-SHA256 signature if META_APP_SECRET is configured
  const appSecret = process.env.META_APP_SECRET;
  if (appSecret) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      console.warn('❌ [SECURITY] Missing x-hub-signature-256 header on Meta webhook');
      return res.status(401).json({ error: 'Signature required' });
    }
    const rawBody = Buffer.isBuffer(req.rawBody)
      ? req.rawBody
      : typeof req.rawBody === 'string'
        ? Buffer.from(req.rawBody, 'utf8')
        : Buffer.from(JSON.stringify(body), 'utf8');

    const expectedSignature = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    try {
      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expectedSignature);
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        console.warn('❌ [SECURITY] Invalid x-hub-signature-256 on Meta webhook');
        return res.status(403).json({ error: 'Invalid webhook signature' });
      }
    } catch (e) {
      return res.status(403).json({ error: 'Signature validation failed' });
    }
  }

  console.log('--- Incoming Meta Webhook ---');
  console.log(JSON.stringify(body, null, 2));

  // 1. Separate parsers based on object type
  if (body.object === 'instagram' || body.object === 'page') {
    try {
      for (const entry of (body.entry || [])) {
        // Some Instagram payloads use 'messaging', others use 'changes'
        let messagingEvents = entry.messaging || [];
        
        // If 'changes' exists, map it to the standard messaging format
        if (entry.changes && entry.changes.length > 0) {
          entry.changes.forEach(change => {
            if (change.value && change.value.message) {
              messagingEvents.push(change.value);
            }
          });
        }
        
        for (const webhookEvent of messagingEvents) {
          // Check if this is a message event
          if (webhookEvent.message) {
            const senderId = webhookEvent.sender ? webhookEvent.sender.id : null;
            const recipientId = webhookEvent.recipient ? webhookEvent.recipient.id : null;
            const messageObj = webhookEvent.message;
            const messageId = messageObj.mid;
            const timestamp = webhookEvent.timestamp || Date.now();
            
            if (!senderId) continue;

            const platform = body.object === 'instagram' ? 'INSTAGRAM' : 'MESSENGER';
            
            // Ignore echoes (messages sent by our own page/app)
            if (messageObj.is_echo) {
              console.log(`[Meta ${platform}] Ignored echo message: ${messageId}`);
              continue;
            }

            // Extract message text and attachments
            let text = messageObj.text || '';
            if (messageObj.attachments && Array.isArray(messageObj.attachments) && messageObj.attachments.length > 0) {
              const attachList = messageObj.attachments.map(att => {
                const type = att.type || 'media';
                const url = att.payload?.url || '';
                return url ? `[${type.toUpperCase()}: ${url}]` : `[${type.toUpperCase()}]`;
              }).join('\n');
              text = text ? `${text}\n${attachList}` : attachList;
            }
            if (!text.trim()) {
              text = '[Attachment/Media]';
            }

            console.log(`[Meta ${platform}] Received message from ${senderId}: ${text}`);
            
            // 2. Resolve Customer Identity
            let customer = await prisma.customer.findFirst({
              where: {
                OR: [
                  { platformUserId: senderId },
                  { platformIdentities: { some: { platform, platformUserId: senderId } } },
                  { phone: senderId },
                  { phone: `ig_${senderId}` }
                ]
              }
            });

            if (!customer) {
              const defaultName = platform === 'INSTAGRAM' ? `Instagram User (${senderId.slice(-4)})` : `${platform} User ${senderId.substring(0, 5)}`;
              const syntheticPhone = `ig_${senderId}`;
              
              customer = await prisma.customer.create({
                data: { 
                  name: defaultName, 
                  phone: syntheticPhone,
                  platform: platform,
                  platformUserId: senderId,
                  platformIdentities: {
                    create: {
                      platform: platform,
                      platformUserId: senderId,
                      username: null
                    }
                  }
                }
              });
              console.log(`[DB] Created new customer: ${customer.id}`);
            } else if (!customer.platform || !customer.platformUserId) {
              customer = await prisma.customer.update({
                where: { id: customer.id },
                data: {
                  platform: platform,
                  platformUserId: senderId
                }
              });
            }

            // Enqueue Instagram profile enrichment if not yet enriched
            if (platform === 'INSTAGRAM' && !customer.profileEnriched) {
              enqueueInstagramEnrichment(customer.id, senderId).catch(err => {
                console.error('[Meta Webhook] Failed to enqueue Instagram enrichment:', err.message);
              });
            }

            // 3. Resolve Conversation
            let conversation = await prisma.conversation.findFirst({
              where: { customerId: customer.id, channel: platform, status: 'OPEN' }
            });

            if (!conversation) {
              conversation = await prisma.conversation.create({
                data: {
                  customerId: customer.id,
                  channel: platform,
                  priority: 'NORMAL',
                  unreadCount: 0
                }
              });
              console.log(`[DB] Created new conversation: ${conversation.id}`);
            }

            // 4. Idempotent check for duplicate message using provider messageId (mid)
            if (messageId) {
              const dedupKey = `meta_msg_dedup:${messageId}`;
              try {
                const isNew = await redisConnection.set(dedupKey, '1', 'EX', 86400, 'NX');
                if (!isNew) {
                  console.log(`[Meta ${platform}] Duplicate message event ignored: ${messageId}`);
                  continue;
                }
              } catch (dedupErr) {
                console.warn('[Meta Webhook] Dedup check error:', dedupErr.message);
              }
            }

            const savedMessage = await prisma.message.create({
              data: {
                conversationId: conversation.id,
                senderType: 'CUSTOMER',
                content: text,
                status: 'DELIVERED'
              }
            });

            // 5. Update Conversation Unread Count & Timestamp
            const updatedConv = await prisma.conversation.update({
              where: { id: conversation.id },
              data: { 
                unreadCount: { increment: 1 },
                updatedAt: new Date()
              },
              include: { customer: true }
            });

            // 6. Trigger AI Enquiry Intelligence
            analyzeAndSaveConversation(conversation.id, io).catch(err => {
              console.error('[Meta Webhook] AI Enquiry Intelligence error:', err.message);
            });

            // 7. Emit Realtime Events
            if (io) {
              const socketPayload = { 
                conversation: updatedConv, 
                message: savedMessage, 
                customer: customer 
              };

              console.log('📡 => Emitting Socket.io event: new_message', JSON.stringify(socketPayload.message.content));

              // Standard generic event (handles UI injection)
              io.emit('new_message', socketPayload);
              io.emit('conversationUpdated', updatedConv);
              
              // Platform specific events
              if (platform === 'INSTAGRAM') {
                console.log('📡 => Emitting Socket.io event: new_instagram_message');
                io.emit('new_instagram_message', socketPayload);
              } else {
                console.log('📡 => Emitting Socket.io event: new_messenger_message');
                io.emit('new_messenger_message', socketPayload);
              }
            }
          }
        }
      }
      res.status(200).send('EVENT_RECEIVED');
    } catch (err) {
      console.error('❌ Failed to process Meta webhook:', err);
      res.status(200).send('EVENT_RECEIVED');
    }
  } else {
    // Return a '404 Not Found' if event is not from a supported subscription
    res.sendStatus(404);
  }
});

module.exports = router;

