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
    const whereClause = {};
    if (agentId) whereClause.assignedAgentId = agentId;
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

    const followup = await prisma.leadFollowup.create({
      data: {
        leadId,
        assignedAgentId: agentId,
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
