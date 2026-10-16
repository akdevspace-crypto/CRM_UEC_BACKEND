const express = require('express');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const prisma = require('../prisma');
const router = express.Router();

const redisConnection = process.env.REDIS_URL 
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null }) 
  : new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
    });

redisConnection.on('error', (err) => {
  console.error('[Redis Followups] Error:', err.message);
});

// Connect to Reminder Queue
const reminderQueue = new Queue('reminderQueue', { connection: redisConnection });

// GET /api/v1/followups
router.get('/', async (req, res) => {
  try {
    const { agentId, status } = req.query;
    const reqRole = req.user?.role;
    const reqAgentId = req.user?.agentId || req.user?.userId;
    const isElevated = reqRole && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(reqRole);

    const whereClause = {};
    if (!isElevated) {
      // Agents only see their assigned followups
      if (reqAgentId) whereClause.assignedAgentId = reqAgentId;
    } else if (agentId) {
      whereClause.assignedAgentId = agentId;
    }

    if (status) whereClause.status = status;

    const followups = await prisma.leadFollowup.findMany({
      where: whereClause,
      include: {
        lead: true,
        assignedAgent: true
      },
      orderBy: { followupDate: 'asc' }
    });

    res.json(followups);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch followups' });
  }
});

// POST /api/v1/followups
router.post('/', async (req, res) => {
  try {
    const { leadId, agentId, followupDate, meetingType, purpose, notes } = req.body;
    const isElevated = req.user?.role && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(req.user.role);
    const assignedAgentId = (isElevated && agentId) ? agentId : (req.user?.agentId || req.user?.userId);

    const followup = await prisma.leadFollowup.create({
      data: {
        leadId,
        assignedAgentId,
        followupDate: new Date(followupDate),
        meetingType,
        purpose,
        notes,
        status: 'PENDING'
      },
      include: { lead: true }
    });

    // Update Lead status to FOLLOWUP_REQUIRED
    await prisma.lead.update({
      where: { id: leadId },
      data: { status: 'FOLLOWUP_REQUIRED' }
    });

    // Log the conversion
    await prisma.leadConversionLog.create({
      data: {
        leadId,
        agentId,
        newStatus: 'FOLLOWUP_REQUIRED',
        notes: `Scheduled ${meetingType} for ${followupDate}`
      }
    });

    // Schedule Reminders via BullMQ
    // 1. One day before
    const oneDayBefore = new Date(followup.followupDate).getTime() - (24 * 60 * 60 * 1000);
    if (oneDayBefore > Date.now()) {
      await reminderQueue.add('sendReminder', { followupId: followup.id, type: '1_DAY_BEFORE' }, { delay: oneDayBefore - Date.now() });
    }

    // 2. One hour before
    const oneHourBefore = new Date(followup.followupDate).getTime() - (60 * 60 * 1000);
    if (oneHourBefore > Date.now()) {
      await reminderQueue.add('sendReminder', { followupId: followup.id, type: '1_HOUR_BEFORE' }, { delay: oneHourBefore - Date.now() });
    }

    const io = req.app.get('io');
    if (io) io.emit('followupCreated', followup);

    res.json(followup);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to schedule followup' });
  }
});

// PUT /api/v1/followups/:id/status
router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const existing = await prisma.leadFollowup.findUnique({
      where: { id: req.params.id }
    });
    if (!existing) {
      return res.status(404).json({ error: 'Followup not found' });
    }

    const reqRole = req.user?.role;
    const reqAgentId = req.user?.agentId || req.user?.userId;
    const isElevated = reqRole && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(reqRole);

    if (!isElevated && existing.assignedAgentId && existing.assignedAgentId !== reqAgentId && existing.assignedAgentId !== req.user?.id) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions to update this followup' });
    }

    const followup = await prisma.leadFollowup.update({
      where: { id: req.params.id },
      data: { status }
    });

    const io = req.app.get('io');
    if (io) io.emit('followupUpdated', followup);

    res.json(followup);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update followup' });
  }
});

module.exports = router;
