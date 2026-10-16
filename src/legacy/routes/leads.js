const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const Redis = require('ioredis');
const { requireRole } = require('../middleware/auth');

const prisma = require('../prisma');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

// POST /api/v1/leads/upload (Super Admin / Admin / Supervisor / Senior Manager)
router.post('/upload', requireRole(['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER']), upload.single('file'), async (req, res) => {
  try {
    const uploadedById = req.user?.userId || req.user?.id || req.body.uploadedById;
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

    invalidateLeadsCache();
    const io = req.app.get('io');
    if (io) io.emit('leadsUpdated'); // Broadcast change

    res.json({ success: true, successfulRows, failedRows, errors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// POST /api/v1/leads - Create single lead
router.post('/', async (req, res) => {
  try {
    const { customerName, phoneNumber, email, serviceInterest, notes, source, city, assignedAgentId, status } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const lead = await prisma.lead.create({
      data: {
        customerName: customerName || 'Unknown Lead',
        phoneNumber: String(phoneNumber).trim(),
        email: email || null,
        serviceInterest: serviceInterest || null,
        notes: notes || null,
        source: source || 'Manual Entry',
        city: city || null,
        assignedAgentId: assignedAgentId || null,
        status: status || 'NEW'
      }
    });

    invalidateLeadsCache();
    const io = req.app.get('io');
    if (io) io.emit('leadsUpdated', lead);

    res.json(lead);
  } catch (err) {
    console.error('[Leads Create] Error:', err);
    res.status(500).json({ error: 'Failed to create lead', details: err.message });
  }
});

// Short-lived query cache with single-flight de-duplication to prevent DB pool exhaustion under high concurrency
const leadsDbCache = new Map();
const inFlightLeadsQueries = new Map();
const LEADS_CACHE_TTL = 3000; // 3 seconds

function invalidateLeadsCache() {
  leadsDbCache.clear();
}

// GET /api/v1/leads
router.get('/', async (req, res) => {
  try {
    const { status, agentId, service, search, q, query } = req.query;
    const whereClause = {};
    if (status) whereClause.status = status;
    if (agentId) whereClause.assignedAgentId = agentId;
    if (service) whereClause.serviceInterest = service;

    const searchTerm = search || q || query;
    if (searchTerm) {
      whereClause.OR = [
        { customerName: { contains: searchTerm, mode: 'insensitive' } },
        { phoneNumber: { contains: searchTerm } },
        { email: { contains: searchTerm, mode: 'insensitive' } },
      ];
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const cacheKey = JSON.stringify({ whereClause, limit });
    const now = Date.now();

    let leads;
    const cached = leadsDbCache.get(cacheKey);
    if (cached && (now - cached.timestamp < LEADS_CACHE_TTL)) {
      leads = cached.data;
    } else if (inFlightLeadsQueries.has(cacheKey)) {
      leads = await inFlightLeadsQueries.get(cacheKey);
    } else {
      const fetchPromise = (async () => {
        return await prisma.lead.findMany({
          where: whereClause,
          select: {
            id: true,
            customerName: true,
            phoneNumber: true,
            email: true,
            serviceInterest: true,
            source: true,
            status: true,
            conversionScore: true,
            sentiment: true,
            createdAt: true,
            assignedAgentId: true,
            assignedAgent: {
              select: { name: true }
            },
            followups: {
              select: { followupDate: true },
              orderBy: { followupDate: 'asc' },
              take: 1
            }
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
      })();

      inFlightLeadsQueries.set(cacheKey, fetchPromise);
      try {
        leads = await fetchPromise;
        leadsDbCache.set(cacheKey, { data: leads, timestamp: Date.now() });
      } finally {
        inFlightLeadsQueries.delete(cacheKey);
      }
    }

    // Mask phone numbers if agent is requesting and lead is not assigned to them
    const reqAgentId = req.user?.agentId || req.user?.userId;
    const reqRole = req.user?.role;
    const isElevated = reqRole && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(reqRole);
    
    const formatted = leads.map(l => {
      let phone = l.phoneNumber;
      if (!isElevated) {
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

// GET /api/v1/leads/:id
router.get('/:id', async (req, res) => {
  try {
    const leadId = req.params.id;
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        assignedAgent: true,
        followups: { orderBy: { followupDate: 'asc' } },
      }
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch lead' });
  }
});

// PUT /api/v1/leads/:id (Full Lead Update)
router.put('/:id', async (req, res) => {
  try {
    const leadId = req.params.id;
    const { customerName, phoneNumber, email, serviceInterest, notes, source, assignedAgentId } = req.body;
    
    const existing = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    const updateData = {};
    if (customerName !== undefined) updateData.customerName = customerName;
    if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber;
    if (email !== undefined) updateData.email = email;
    if (serviceInterest !== undefined) updateData.serviceInterest = serviceInterest;
    if (notes !== undefined) updateData.notes = notes;
    if (source !== undefined) updateData.source = source;
    if (assignedAgentId !== undefined) updateData.assignedAgentId = assignedAgentId;

    const updatedLead = await prisma.lead.update({
      where: { id: leadId },
      data: updateData
    });

    invalidateLeadsCache();
    const io = req.app.get('io');
    if (io) io.emit('leadUpdated', updatedLead);

    res.json(updatedLead);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// DELETE /api/v1/leads/:id
router.delete('/:id', requireRole(['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR']), async (req, res) => {
  try {
    const leadId = req.params.id;
    const existing = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    // Delete related conversion logs and followups safely in transaction
    await prisma.$transaction([
      prisma.leadConversionLog.deleteMany({ where: { leadId } }),
      prisma.leadFollowup.deleteMany({ where: { leadId } }),
      prisma.lead.delete({ where: { id: leadId } })
    ]);
    
    invalidateLeadsCache();
    const io = req.app.get('io');
    if (io) io.emit('leadDeleted', { id: leadId });

    res.json({ success: true, message: 'Lead deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete lead' });
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

    invalidateLeadsCache();
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
  const isElevated = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER'].includes(req.user?.role);
  const agentId = (isElevated && req.body.agentId) ? req.body.agentId : (req.user?.agentId || req.user?.userId);
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
    invalidateLeadsCache();
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
  const { status, notes } = req.body;
  const isElevated = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER'].includes(req.user?.role);
  const agentId = (isElevated && req.body.agentId) ? req.body.agentId : (req.user?.agentId || req.user?.userId);
  
  try {
    if (!UUID_REGEX.test(leadId)) return res.status(404).json({ error: 'Lead not found' });
    const oldLead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!oldLead) return res.status(404).json({ error: 'Lead not found' });

    let effectiveAgentId = null;
    if (agentId && UUID_REGEX.test(agentId)) {
      const agentRecord = await prisma.agent.findFirst({
        where: { OR: [{ id: agentId }, { userId: agentId }] }
      });
      if (agentRecord) effectiveAgentId = agentRecord.id;
    }
    
    const updatedLead = await prisma.lead.update({
      where: { id: leadId },
      data: { 
        status,
        ...(notes !== undefined ? { notes } : {})
      }
    });

    await prisma.leadConversionLog.create({
      data: {
        leadId,
        agentId: effectiveAgentId,
        oldStatus: oldLead.status,
        newStatus: status,
        notes: notes || null
      }
    });

    invalidateLeadsCache();
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
  const { notes, appointmentDate, appointmentPurpose, sentiment: manualSentiment } = req.body;
  const isElevated = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER'].includes(req.user?.role);
  const agentId = (isElevated && req.body.agentId) ? req.body.agentId : (req.user?.agentId || req.user?.userId);
  
  try {
    if (!UUID_REGEX.test(leadId)) return res.status(404).json({ error: 'Lead not found' });
    const oldLead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!oldLead) return res.status(404).json({ error: 'Lead not found' });

    let effectiveAgentId = null;
    if (agentId && UUID_REGEX.test(agentId)) {
      const agentRecord = await prisma.agent.findFirst({
        where: { OR: [{ id: agentId }, { userId: agentId }] }
      });
      if (agentRecord) effectiveAgentId = agentRecord.id;
    }

    let sentiment = 'NEUTRAL';
    let newStatus = 'CONVERTED';

    if (manualSentiment) {
      sentiment = manualSentiment;
      newStatus = manualSentiment === 'POSITIVE' || manualSentiment === 'NEGATIVE' ? 'CONVERTED' : manualSentiment;
    } else {
      // Safe fallback sentiment analysis against null/undefined notes (DEF-23)
      const lowerNotes = (typeof notes === 'string' ? notes : (notes ? String(notes) : '')).toLowerCase();
      const positiveWords = ['interested', 'yes', 'schedule', 'positive', 'good', 'great', 'callback', 'meet'];
      const negativeWords = ['not interested', 'no', 'negative', 'bad', 'angry', 'do not call', 'wrong number'];

      if (negativeWords.some(w => lowerNotes.includes(w))) {
        sentiment = 'NEGATIVE';
        newStatus = 'NEGATIVE';
      } else if (positiveWords.some(w => lowerNotes.includes(w))) {
        sentiment = 'POSITIVE';
        newStatus = 'CONVERTED';
      } else {
        sentiment = 'NEUTRAL';
        newStatus = 'CONVERTED';
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
        agentId: effectiveAgentId,
        oldStatus: oldLead.status,
        newStatus,
        notes: notes || null
      }
    });

    // If appointment date provided, schedule follow-up with safe agent resolution
    if (appointmentDate) {
      let agentForFollowup = effectiveAgentId || oldLead.assignedAgentId;
      if (!agentForFollowup) {
        const firstAgent = await prisma.agent.findFirst();
        if (firstAgent) agentForFollowup = firstAgent.id;
      }
      if (agentForFollowup) {
        await prisma.leadFollowup.create({
          data: {
            leadId,
            assignedAgentId: agentForFollowup,
            followupDate: new Date(appointmentDate),
            purpose: appointmentPurpose || 'Follow-up meeting',
            meetingType: 'APPOINTMENT'
          }
        }).catch(err => console.warn('[Followup Warning]', err.message));
      }
    }

    invalidateLeadsCache();
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
