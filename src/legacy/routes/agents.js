const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const router = express.Router();
const prisma = require('../prisma');

// Initialize Supabase Admin Client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://aws-1-ap-southeast-1.pooler.supabase.com';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy_key';
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redis.on('error', (err) => {
  console.error('[Redis Agents] Error:', err.message);
});

// GET all agents
router.get('/', async (req, res) => {
  console.log('[Agents Route] Received GET /');
  try {
    const agents = await prisma.agent.findMany({
      where: { isDeleted: false },
      include: { user: true },
      orderBy: { createdAt: 'desc' }
    });
    console.log('[Agents Route] Prisma query complete');

    // Fetch real-time presence from Redis with fast fallback (150ms timeout)
    const onlineAgents = {};
    try {
      if (redis.status === 'ready') {
        const fetchRedis = async () => {
          const keys = await redis.keys('agent:*');
          if (keys && keys.length > 0) {
            const values = await redis.mget(keys);
            for (const val of values) {
              if (val) {
                try {
                  const parsed = JSON.parse(val);
                  if (parsed.agentId) onlineAgents[parsed.agentId] = parsed.status;
                } catch (_) {}
              }
            }
          }
        };
        await Promise.race([
          fetchRedis(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 150))
        ]);
      }
    } catch (e) {
      // Gracefully fall back to DB status without stalling HTTP response
    }
    
    console.log('[Agents Route] Formatting response');
    const isElevated = req.user && ['SUPER_ADMIN', 'ADMIN'].includes(req.user.role);
    // Flatten user attributes to agent level for frontend compatibility
    const formattedAgents = agents.map(a => {
      const { user, ...agentData } = a;
      const effectiveUserId = user?.id || a.userId;
      if (!isElevated) {
        delete agentData.address;
        delete agentData.zipCode;
      }
      return {
        ...agentData,
        role: user?.role || 'AGENT',
        email: user?.email || '',
        status: onlineAgents[effectiveUserId] || onlineAgents[a.id] || a.status || 'OFFLINE'
      };
    });

    console.log('[Agents Route] Sending response');
    res.json({ success: true, agents: formattedAgents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

// GET dashboard metrics
router.get('/dashboard-metrics', async (req, res) => {
  try {
    const agentId = req.query.agentId; // Optional: Scope to specific agent
    
    // Base filters
    const callFilter = agentId ? { agentId } : {};
    const ticketFilter = agentId ? { agentId, status: { not: 'RESOLVED' } } : { status: { not: 'RESOLVED' } };
    const conversationFilter = agentId ? { agentId } : {};
    
    // Fetch top metrics
    const [connectedCalls, activeCalls, queueCalls, assignedTickets] = await Promise.all([
      prisma.callLog.count({ where: { ...callFilter, status: 'completed' } }),
      prisma.callLog.count({ where: { ...callFilter, status: 'in-progress' } }),
      prisma.queueItem.count({ where: { status: 'WAITING' } }),
      prisma.ticket.count({ where: ticketFilter })
    ]);

    // Fetch Unread Messages
    const unreadMessagesResult = await prisma.conversation.aggregate({
      where: conversationFilter,
      _sum: { unreadCount: true }
    });
    const unreadMessages = unreadMessagesResult._sum.unreadCount || 0;

    // Call Volume Analytics (Last 7 days aggregation - simplified)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentCalls = await prisma.callLog.findMany({
      where: { ...callFilter, createdAt: { gte: sevenDaysAgo } },
      select: { createdAt: true }
    });
    // Just a placeholder grouping format for now
    const callVolume = [
      { day: 'S', value: 0 }, { day: 'M', value: 0 }, { day: 'T', value: 0 }, 
      { day: 'W', value: 0 }, { day: 'T', value: 0 }, { day: 'F', value: 0 }, { day: 'S', value: 0 }
    ];
    recentCalls.forEach(call => {
      const dayIdx = call.createdAt.getDay();
      callVolume[dayIdx].value += 1;
    });

    // Customer Feedback Sentiment (Aggregation of AI call summary)
    const aiSummaries = await prisma.aiSummary.findMany({
      where: { conversation: conversationFilter }
    });
    let positive = 0, neutral = 0, negative = 0;
    aiSummaries.forEach(s => {
      const score = (s.sentimentScore || '').toUpperCase();
      if (score === 'POSITIVE') positive++;
      else if (score === 'NEGATIVE') negative++;
      else neutral++;
    });
    let customerFeedback = { positive: 0, neutral: 100, negative: 0 };
    const totalSentiment = positive + neutral + negative;
    if (totalSentiment > 0) {
      customerFeedback = {
        positive: Math.round((positive / totalSentiment) * 100),
        neutral: Math.round((neutral / totalSentiment) * 100),
        negative: Math.round((negative / totalSentiment) * 100)
      };
    }

    // Past Calls List
    const pastCalls = await prisma.callLog.findMany({
      where: callFilter,
      include: { customer: true },
      orderBy: { createdAt: 'desc' },
      take: 5
    });

    // Online Agents for Quick Transfer
    const allAgentsForDashboard = await prisma.agent.findMany({
      include: { user: true }
    });
    
    const dashboardOnlineAgents = {};
    try {
      if (redis.status === 'ready') {
        const fetchDashboardRedis = async () => {
          const dashboardKeys = await redis.keys('agent:*');
          for (const key of dashboardKeys) {
            const agentStr = await redis.get(key);
            if (agentStr) {
              const parsed = JSON.parse(agentStr);
              dashboardOnlineAgents[parsed.agentId] = parsed.status;
            }
          }
        };
        await Promise.race([
          fetchDashboardRedis(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 2000))
        ]);
      }
    } catch (e) {}

    const onlineAgents = allAgentsForDashboard.map(a => {
      const effectiveUserId = a.user?.id || a.userId;
      return {
        id: a.id,
        name: a.name,
        department: a.department,
        avatarUrl: a.avatarUrl,
        status: dashboardOnlineAgents[effectiveUserId] || dashboardOnlineAgents[a.id] || 'OFFLINE'
      };
    }).filter(a => a.status === 'AVAILABLE' || a.status === 'BUSY').slice(0, 5);

    // Reminders / Urgent Ticket
    const urgentTicket = await prisma.ticket.findFirst({
      where: { ...ticketFilter, priority: { in: ['HIGH', 'EMERGENCY'] } },
      include: { customer: true },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ 
      success: true, 
      metrics: {
        connectedCalls,
        activeCalls,
        queueCalls,
        assignedTickets,
        unreadMessages
      },
      callVolume,
      customerFeedback,
      pastCalls,
      onlineAgents,
      urgentTicket
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch dashboard metrics' });
  }
});

// CREATE agent
router.post('/create', async (req, res) => {
  const {
    fullName, email, password, phone, address, city, state, country, zipCode,
    gender, dob, employeeId, department, role, status, joinedAt
  } = req.body;

  try {
    if (role === 'SUPER_ADMIN') {
      const existingSuperAdmin = await prisma.user.findFirst({
        where: { role: 'SUPER_ADMIN' }
      });
      if (existingSuperAdmin) {
        return res.status(400).json({ error: 'Only one Super Admin slot is allowed in the system.' });
      }
    }

    // 1. Create user in Supabase Auth (Admin API)
    // Note: If you don't actually use Supabase Auth, you can comment this out and rely on Prisma only.
    let authUserId = null;
    try {
      const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName, role: role || 'AGENT' }
      });
      if (authError) {
        console.warn('Supabase Auth error:', authError.message);
        // Fallback: If Supabase admin isn't fully configured, we continue to create Prisma record
      } else if (authUser?.user) {
        authUserId = authUser.user.id;
      }
    } catch (sbErr) {
       console.warn('Supabase integration error:', sbErr);
    }

    // 2. Hash password for local DB login
    const passwordHash = await bcrypt.hash(password || 'defaultPass123', 10);

    // 3. Create User and Agent in Prisma
    const newAgent = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          passwordHash,
          role: role || 'AGENT',
          authUserId
        }
      });

      return await tx.agent.create({
        data: {
          userId: user.id,
          name: fullName,
          phone,
          address,
          city,
          state,
          country,
          zipCode,
          gender,
          dob: dob ? new Date(dob) : null,
          employeeId,
          department,
          status: status || 'OFFLINE',
          joinedAt: joinedAt ? new Date(joinedAt) : new Date()
        },
        include: { user: true }
      });
    });

    // Broadcast update
    const io = req.app.get('io');
    if (io) io.emit('agentListUpdated', newAgent);

    res.json({ success: true, agent: newAgent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create agent', details: err.message });
  }
});

// UPDATE agent
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;
  
  try {
    // Extract user specific fields
    const userUpdate = {};
    if (updateData.email) userUpdate.email = updateData.email;
    if (updateData.role) {
      if (updateData.role === 'SUPER_ADMIN') {
        const existingSuperAdmin = await prisma.user.findFirst({
          where: { role: 'SUPER_ADMIN' }
        });
        const agentRecord = await prisma.agent.findUnique({ where: { id } });
        if (existingSuperAdmin && existingSuperAdmin.id !== agentRecord.userId) {
          return res.status(400).json({ error: 'Only one Super Admin slot is allowed in the system.' });
        }
      }
      userUpdate.role = updateData.role;
    }
    if (updateData.password) {
      userUpdate.passwordHash = await bcrypt.hash(updateData.password, 10);
    }

    // Remove user fields from agent update payload
    const { email, password, role, ...agentUpdate } = updateData;
    
    // Format dates
    if (agentUpdate.dob) agentUpdate.dob = new Date(agentUpdate.dob);
    if (agentUpdate.joinedAt) agentUpdate.joinedAt = new Date(agentUpdate.joinedAt);

    const updatedAgent = await prisma.$transaction(async (tx) => {
      if (Object.keys(userUpdate).length > 0) {
        const agentRecord = await tx.agent.findUnique({ where: { id } });
        await tx.user.update({
          where: { id: agentRecord.userId },
          data: userUpdate
        });
      }
      return await tx.agent.update({
        where: { id },
        data: agentUpdate,
        include: { user: true }
      });
    });

    const io = req.app.get('io');
    if (io) io.emit('agentListUpdated', updatedAgent);

    res.json({ success: true, agent: updatedAgent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

// DELETE agent (Soft Delete)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const deletedAgent = await prisma.agent.update({
      where: { id },
      data: { isDeleted: true, status: 'OFFLINE' }
    });

    const io = req.app.get('io');
    if (io) io.emit('agentListUpdated', deletedAgent);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

module.exports = router;
