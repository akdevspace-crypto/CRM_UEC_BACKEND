const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const Redis = require('ioredis');

const prisma = require('../prisma');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Connect to Redis for distributed locks
const redisConnection = process.env.REDIS_URL 
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null }) 
  : new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
    });

redisConnection.on('error', (err) => {
  console.error('[Redis Leads] Error:', err.message);
});

// POST /api/v1/leads/upload (Super Admin / Admin)
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { uploadedById } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Parse file based on extension
    let data = [];
    const fileName = req.file.originalname;
    
    if (fileName.endsWith('.xlsx') || fileName.endsWith('.csv')) {
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    } else {
      return res.status(400).json({ error: 'Unsupported file format' });
    }

    // 1. Create Upload History
    const history = await prisma.leadUploadHistory.create({
      data: {
        fileName,
        uploadedById,
        totalRows: data.length,
        status: 'PROCESSING'
      }
    });

    let successfulRows = 0;
    let failedRows = 0;
    const errors = [];

    // 2. Process rows
    for (const [index, row] of data.entries()) {
      try {
        const phone = String(row.phone_number || row.phone || row.phoneNumber || '').trim();
        const name = row.customer_name || row.name || row.customerName || 'Unknown';
        if (!phone) throw new Error('Missing phone number');

        await prisma.lead.upsert({
          where: { phoneNumber: phone },
          update: {
            // Update if existing? For now, we skip or update source
            source: row.source || 'Excel Upload',
            serviceInterest: row.service_interest || row.serviceInterest || null,
          },
          create: {
            customerName: name,
            phoneNumber: phone,
            email: row.email || null,
            serviceInterest: row.service_interest || row.serviceInterest || null,
            city: row.city || null,
            notes: row.notes || null,
            source: row.source || 'Excel Upload',
            status: 'NEW',
            uploadedById,
            uploadHistoryId: history.id
          }
        });
        successfulRows++;
      } catch (err) {
        failedRows++;
        errors.push({ row: index + 2, error: err.message });
      }
    }

    // 3. Update History
    await prisma.leadUploadHistory.update({
      where: { id: history.id },
      data: {
        successfulRows,
        failedRows,
        status: 'COMPLETED',
        errorLog: errors
      }
    });

    const io = req.app.get('io');
    if (io) io.emit('leadsUpdated'); // Broadcast change

    res.json({ success: true, successfulRows, failedRows, errors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// GET /api/v1/leads
router.get('/', async (req, res) => {
  try {
    const { status, agentId, service } = req.query;
    const whereClause = {};
    if (status) whereClause.status = status;
    if (agentId) whereClause.assignedAgentId = agentId;
    if (service) whereClause.serviceInterest = service;

    const leads = await prisma.lead.findMany({
      where: whereClause,
      include: {
        assignedAgent: true,
        followups: { orderBy: { followupDate: 'asc' }, take: 1 }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Mask phone numbers if agent is requesting and lead is not assigned to them
    const reqAgentId = req.headers['x-agent-id'];
    const reqRole = req.headers['x-user-role']; // Passed from frontend or middleware
    
    const formatted = leads.map(l => {
      let phone = l.phoneNumber;
      if (reqRole !== 'SUPER_ADMIN' && reqRole !== 'ADMIN') {
        if (l.assignedAgentId !== reqAgentId) {
          // Mask phone: XXXXXX4521
          phone = phone.length > 4 ? 'X'.repeat(phone.length - 4) + phone.slice(-4) : 'XXXX';
        }
      }

      return {
        id: l.id,
        customerName: l.customerName,
        phoneNumber: phone,
        email: l.email,
        serviceInterest: l.serviceInterest,
        source: l.source,
        status: l.status,
        conversionScore: l.conversionScore,
        sentiment: l.sentiment,
        createdAt: l.createdAt,
        agentName: l.assignedAgent?.name || 'Unassigned',
        assignedAgentId: l.assignedAgentId,
        nextFollowup: l.followups[0] ? l.followups[0].followupDate : null
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// POST /api/v1/leads (Manual Entry)
router.post('/', async (req, res) => {
  const { customerName, phoneNumber, email, serviceInterest, source, notes, agentId } = req.body;
  try {
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

    const newLead = await prisma.lead.upsert({
      where: { phoneNumber },
      update: {
        customerName: customerName || undefined,
        email: email || undefined,
        serviceInterest: serviceInterest || undefined,
        source: source || undefined,
        notes: notes || undefined,
      },
      create: {
        customerName: customerName || 'Unknown',
        phoneNumber,
        email: email || null,
        serviceInterest: serviceInterest || null,
        source: source || 'Manual Entry',
        notes: notes || null,
        status: 'NEW',
        uploadedById: agentId || null,
      }
    });

    const io = req.app.get('io');
    if (io) io.emit('leadsUpdated');

    res.json({ success: true, lead: newLead });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

// POST /api/v1/leads/:id/claim
router.post('/:id/claim', async (req, res) => {
  const leadId = req.params.id;
  const { agentId } = req.body;
  const lockKey = `lead_lock:${leadId}`;

  try {
    // 1. Try to acquire Redis Lock to prevent race condition
    const acquired = await redisConnection.set(lockKey, agentId, 'NX', 'EX', 10);
    if (!acquired) {
      return res.status(409).json({ error: 'Lead is currently being claimed by another agent' });
    }

    // 2. Double check DB
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.assignedAgentId) {
      await redisConnection.del(lockKey);
      return res.status(400).json({ error: 'Lead already claimed or not found' });
    }

    // 3. Assign to agent
    const updatedLead = await prisma.lead.update({
      where: { id: leadId },
      data: {
        assignedAgentId: agentId,
        status: 'IN_PROGRESS',
        lockedAt: new Date()
      }
    });

    // 4. Log conversion history
    await prisma.leadConversionLog.create({
      data: {
        leadId,
        agentId,
        oldStatus: 'NEW',
        newStatus: 'IN_PROGRESS',
        notes: 'Lead claimed by agent'
      }
    });

    // 5. Broadcast to update everyone's pool
    const io = req.app.get('io');
    if (io) io.emit('leadClaimed', { leadId, agentId, status: 'IN_PROGRESS' });

    res.json({ success: true, lead: updatedLead });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to claim lead' });
  } finally {
    // Release the lock
    await redisConnection.del(lockKey);
  }
});

// PUT /api/v1/leads/:id/status
router.put('/:id/status', async (req, res) => {
  const leadId = req.params.id;
  const { status, notes, agentId } = req.body;
  
  try {
    const oldLead = await prisma.lead.findUnique({ where: { id: leadId } });
    
    const updatedLead = await prisma.lead.update({
      where: { id: leadId },
      data: { status }
    });

    await prisma.leadConversionLog.create({
      data: {
        leadId,
        agentId,
        oldStatus: oldLead.status,
        newStatus: status,
        notes
      }
    });

    const io = req.app.get('io');
    if (io) io.emit('leadUpdated', updatedLead);

    res.json(updatedLead);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update lead status' });
  }
});

// POST /api/v1/leads/:id/convert
router.post('/:id/convert', async (req, res) => {
  const leadId = req.params.id;
  const { notes, agentId, appointmentDate, appointmentPurpose, sentiment: manualSentiment } = req.body;
  
  try {
    const oldLead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!oldLead) return res.status(404).json({ error: 'Lead not found' });

    let sentiment = 'NEUTRAL';
    let newStatus = 'IN_PROGRESS';

    if (manualSentiment) {
      sentiment = manualSentiment;
      newStatus = manualSentiment;
    } else {
      // Simple mock sentiment analysis (Fallback)
      const lowerNotes = notes.toLowerCase();
      const positiveWords = ['interested', 'yes', 'schedule', 'positive', 'good', 'great', 'callback', 'meet'];
      const negativeWords = ['not interested', 'no', 'negative', 'bad', 'angry', 'do not call', 'wrong number'];

      if (positiveWords.some(w => lowerNotes.includes(w))) {
        sentiment = 'POSITIVE';
        newStatus = 'POSITIVE';
      } else if (negativeWords.some(w => lowerNotes.includes(w))) {
        sentiment = 'NEGATIVE';
        newStatus = 'NEGATIVE';
      }
    }

    // Update Lead
    const updatedLead = await prisma.lead.update({
      where: { id: leadId },
      data: { 
        status: newStatus,
        sentiment,
        conversionScore: sentiment === 'POSITIVE' ? Math.floor(Math.random() * 20) + 80 : sentiment === 'NEGATIVE' ? Math.floor(Math.random() * 20) + 10 : 50
      }
    });

    // Log Conversion
    await prisma.leadConversionLog.create({
      data: {
        leadId,
        agentId,
        oldStatus: oldLead.status,
        newStatus,
        notes
      }
    });

    // If positive and date provided, schedule follow-up
    if (sentiment === 'POSITIVE' && appointmentDate) {
      await prisma.leadFollowup.create({
        data: {
          leadId,
          assignedAgentId: agentId || oldLead.assignedAgentId,
          followupDate: new Date(appointmentDate),
          purpose: appointmentPurpose || 'Follow-up meeting',
          meetingType: 'APPOINTMENT'
        }
      });
    }

    const io = req.app.get('io');
    if (io) io.emit('leadUpdated', updatedLead);

    res.json({ success: true, lead: updatedLead, sentiment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to convert lead' });
  }
});

// GET /api/v1/leads/analytics
router.get('/analytics/dashboard', async (req, res) => {
  try {
    const totalLeads = await prisma.lead.count();
    const claimedLeads = await prisma.lead.count({ where: { assignedAgentId: { not: null } } });
    const convertedLeads = await prisma.lead.count({ where: { status: 'CONVERTED' } });
    const positiveLeads = await prisma.lead.count({ where: { sentiment: 'POSITIVE' } });

    // Group by Service
    const services = await prisma.lead.groupBy({
      by: ['serviceInterest'],
      _count: { id: true }
    });

    // Conversion rate
    const conversionRate = totalLeads ? ((convertedLeads / totalLeads) * 100).toFixed(1) : 0;

    res.json({
      totalLeads,
      claimedLeads,
      convertedLeads,
      positiveLeads,
      conversionRate,
      services: services.map(s => ({ service: s.serviceInterest || 'Unknown', count: s._count.id }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

module.exports = router;
