const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = require('../prisma');

// Initialize Supabase Admin Client safely
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
if (supabaseUrl && supabaseServiceKey && !supabaseUrl.includes('pooler.supabase.com')) {
  try {
    supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  } catch (err) {
    console.warn('[Agents Route] Warning: Could not initialize Supabase client:', err.message);
  }
}

const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  connectTimeout: 500,
  enableOfflineQueue: false,
  lazyConnect: true
});

redis.on('error', (err) => {
  console.error('[Redis Agents] Error:', err.message);
});

// GET all agents
router.get('/', async (req, res) => {
  console.log('[Agents Route] Received GET /');
  try {
    // Run Prisma query and Redis presence lookups concurrently
    const [agents, onlineAgents] = await Promise.all([
      prisma.agent.findMany({
        where: { isDeleted: false },
        include: { user: true },
        orderBy: { createdAt: 'desc' }
      }),
      (async () => {
        const presenceMap = {};
        if (redis.status === 'ready') {
          try {
            await Promise.race([
              (async () => {
                const keys = await redis.keys('agent:*');
                if (keys && keys.length > 0) {
                  const values = await redis.mget(keys);
                  for (const val of values) {
                    if (val) {
                      try {
                        const parsed = JSON.parse(val);
                        if (parsed.agentId) presenceMap[parsed.agentId] = parsed.status;
                      } catch (_) {}
                    }
                  }
                }
              })(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 100))
            ]);
          } catch (_) {}
        }
        return presenceMap;
      })()
    ]);
    console.log('[Agents Route] Query and presence lookup complete');
    
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
          if (dashboardKeys && dashboardKeys.length > 0) {
            const values = await redis.mget(dashboardKeys);
            for (const agentStr of values) {
              if (agentStr) {
                try {
                  const parsed = JSON.parse(agentStr);
                  if (parsed.agentId) dashboardOnlineAgents[parsed.agentId] = parsed.status;
                } catch (_) {}
              }
            }
          }
        };
        await Promise.race([
          fetchDashboardRedis(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 200))
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

// CREATE agent (Restricted to SUPER_ADMIN, ADMIN, HR)
router.post('/create', requireRole(['SUPER_ADMIN', 'ADMIN', 'HR']), async (req, res) => {
  const {
    fullName, email, password, phone, address, city, state, country, zipCode,
    gender, dob, employeeId, department, role, status, joinedAt, unitId, departmentId,
    reactivate
  } = req.body || {};

  try {
    // 1. Mandatory field validations (400 Bad Request)
    if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
      return res.status(400).json({
        error: 'Validation failed: Full name is required and must be at least 2 characters long.',
        field: 'fullName'
      });
    }

    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        error: 'Validation failed: Email address is required.',
        field: 'email'
      });
    }

    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({
        error: 'Validation failed: Please provide a valid email address.',
        field: 'email'
      });
    }

    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({
        error: 'Validation failed: Password must be at least 6 characters long.',
        field: 'password'
      });
    }

    // 2. Validate enum fields
    const validRoles = ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'AGENT', 'SALES_AGENT', 'EMERGENCY_TEAM'];
    const assignedRole = role ? String(role).trim().toUpperCase() : 'AGENT';
    if (!validRoles.includes(assignedRole)) {
      return res.status(400).json({
        error: `Validation failed: Invalid role "${role}". Allowed roles: ${validRoles.join(', ')}.`,
        field: 'role'
      });
    }

    const validStatuses = ['AVAILABLE', 'BUSY', 'BREAK', 'WRAP_UP', 'OFFLINE'];
    const assignedStatus = status ? String(status).trim().toUpperCase() : 'OFFLINE';
    if (!validStatuses.includes(assignedStatus)) {
      return res.status(400).json({
        error: `Validation failed: Invalid status "${status}". Allowed statuses: ${validStatuses.join(', ')}.`,
        field: 'status'
      });
    }

    // 3. Validate and parse dates safely
    let parsedDob = null;
    if (dob !== undefined && dob !== null && dob !== '') {
      const d = new Date(dob);
      if (isNaN(d.getTime())) {
        return res.status(400).json({
          error: 'Validation failed: Invalid Date of Birth format. Expected a valid date string.',
          field: 'dob'
        });
      }
      parsedDob = d;
    }

    let parsedJoinedAt = new Date();
    if (joinedAt !== undefined && joinedAt !== null && joinedAt !== '') {
      const d = new Date(joinedAt);
      if (isNaN(d.getTime())) {
        return res.status(400).json({
          error: 'Validation failed: Invalid Joining Date format. Expected a valid date string.',
          field: 'joinedAt'
        });
      }
      parsedJoinedAt = d;
    }

    // 4. Sanitize optional unique and string fields
    const cleanFullName = fullName.trim();
    const cleanPhone = phone && typeof phone === 'string' && phone.trim() ? phone.trim() : null;
    const cleanEmployeeId = employeeId && typeof employeeId === 'string' && employeeId.trim() ? employeeId.trim() : null;
    const cleanAddress = address && typeof address === 'string' && address.trim() ? address.trim() : null;
    const cleanCity = city && typeof city === 'string' && city.trim() ? city.trim() : null;
    const cleanState = state && typeof state === 'string' && state.trim() ? state.trim() : null;
    const cleanCountry = country && typeof country === 'string' && country.trim() ? country.trim() : null;
    const cleanZipCode = zipCode && typeof zipCode === 'string' && zipCode.trim() ? zipCode.trim() : null;
    const cleanGender = gender && typeof gender === 'string' && gender.trim() ? gender.trim() : null;
    const cleanDepartment = department && typeof department === 'string' && department.trim() ? department.trim() : null;

    // 5. Foreign Key Validations
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (unitId) {
      if (typeof unitId !== 'string' || !uuidRegex.test(unitId)) {
        return res.status(400).json({
          error: 'Validation failed: unitId must be a valid UUID.',
          field: 'unitId'
        });
      }
      const unitExists = await prisma.businessUnit.findUnique({ where: { id: unitId } });
      if (!unitExists) {
        return res.status(400).json({
          error: `Validation failed: Referenced business unit "${unitId}" does not exist.`,
          field: 'unitId'
        });
      }
    }

    if (departmentId) {
      if (typeof departmentId !== 'string' || !uuidRegex.test(departmentId)) {
        return res.status(400).json({
          error: 'Validation failed: departmentId must be a valid UUID.',
          field: 'departmentId'
        });
      }
      const deptExists = await prisma.department.findUnique({ where: { id: departmentId } });
      if (!deptExists) {
        return res.status(400).json({
          error: `Validation failed: Referenced department "${departmentId}" does not exist.`,
          field: 'departmentId'
        });
      }
    }

    // 6. Super Admin Constraint (409 Conflict)
    if (assignedRole === 'SUPER_ADMIN') {
      const existingSuperAdmin = await prisma.user.findFirst({
        where: { role: 'SUPER_ADMIN' }
      });
      if (existingSuperAdmin) {
        return res.status(409).json({
          error: 'Conflict: Only one Super Admin slot is allowed in the system.',
          field: 'role'
        });
      }
    }

    // 7. Duplicate Checks (409 Conflict)
    const existingUser = await prisma.user.findUnique({
      where: { email: cleanEmail },
      include: { agentProfile: true }
    });

    if (existingUser) {
      const isArchived = existingUser.agentProfile?.isDeleted === true;
      const shouldReactivate = isArchived && (reactivate === true || reactivate === 'true');

      if (!shouldReactivate) {
        return res.status(409).json({
          error: isArchived
            ? `An agent profile with email "${cleanEmail}" already exists (archived). Pass reactivate: true to restore this profile.`
            : `An agent profile with email "${cleanEmail}" already exists.`,
          field: 'email',
          isArchived
        });
      }
    }

    if (cleanEmployeeId) {
      const existingEmp = await prisma.agent.findFirst({
        where: {
          employeeId: cleanEmployeeId,
          isDeleted: false,
          ...(existingUser ? { userId: { not: existingUser.id } } : {})
        }
      });
      if (existingEmp) {
        return res.status(409).json({
          error: `Conflict: An agent with employee ID "${cleanEmployeeId}" already exists.`,
          field: 'employeeId'
        });
      }
    }

    // Handle reactivation of soft-deleted profile
    if (existingUser && existingUser.agentProfile?.isDeleted && (reactivate === true || reactivate === 'true')) {
      const passwordHash = await bcrypt.hash(password, 10);
      const restoredAgent = await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: existingUser.id },
          data: {
            passwordHash,
            role: assignedRole,
          }
        });
        return await tx.agent.update({
          where: { id: existingUser.agentProfile.id },
          data: {
            name: cleanFullName,
            phone: cleanPhone,
            address: cleanAddress,
            city: cleanCity,
            state: cleanState,
            country: cleanCountry,
            zipCode: cleanZipCode,
            gender: cleanGender,
            dob: parsedDob,
            employeeId: cleanEmployeeId,
            department: cleanDepartment,
            status: assignedStatus,
            joinedAt: parsedJoinedAt,
            isDeleted: false,
          },
          include: { user: true }
        });
      });

      const { passwordHash: _, ...safeUser } = restoredAgent.user;
      restoredAgent.user = safeUser;

      const io = req.app.get('io');
      if (io) io.emit('agentListUpdated', restoredAgent);

      return res.status(200).json({
        success: true,
        agent: restoredAgent,
        reactivated: true,
        message: 'Archived agent profile reactivated successfully.'
      });
    }

    // 8. Create user in Supabase Auth if client is available
    let authUserId = null;
    if (supabase) {
      try {
        const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
          email: cleanEmail,
          password,
          email_confirm: true,
          user_metadata: { full_name: cleanFullName, role: assignedRole }
        });
        if (authError) {
          console.warn('[Agents Route] Supabase Auth creation note:', authError.message);
        } else if (authUser?.user) {
          authUserId = authUser.user.id;
        }
      } catch (sbErr) {
        console.warn('[Agents Route] Supabase integration error:', sbErr.message);
      }
    }

    // 9. Hash password for local DB login
    const passwordHash = await bcrypt.hash(password, 10);

    // 10. Create User and Agent in Prisma Transaction
    const newAgent = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: cleanEmail,
          passwordHash,
          role: assignedRole,
          authUserId
        }
      });

      const agent = await tx.agent.create({
        data: {
          userId: user.id,
          name: cleanFullName,
          phone: cleanPhone,
          address: cleanAddress,
          city: cleanCity,
          state: cleanState,
          country: cleanCountry,
          zipCode: cleanZipCode,
          gender: cleanGender,
          dob: parsedDob,
          employeeId: cleanEmployeeId,
          department: cleanDepartment,
          status: assignedStatus,
          joinedAt: parsedJoinedAt
        },
        include: { user: true }
      });

      if (unitId) {
        await tx.unitMembership.create({
          data: {
            unitId,
            userId: user.id,
            roleInUnit: assignedRole === 'SUPERVISOR' ? 'SUPERVISOR' : 'MEMBER'
          }
        });
      }

      return agent;
    });

    // Strip passwordHash before sending response
    const { passwordHash: _, ...safeUser } = newAgent.user;
    newAgent.user = safeUser;

    // Broadcast update
    const io = req.app.get('io');
    if (io) io.emit('agentListUpdated', newAgent);

    return res.status(201).json({ success: true, agent: newAgent });
  } catch (err) {
    if (err.code === 'P2002') {
      const targets = err.meta?.target || [];
      const field = Array.isArray(targets) ? targets.join(', ') : (targets || 'field');
      return res.status(409).json({
        error: `Conflict: An agent with this ${field} already exists.`,
        field
      });
    }

    if (err.code === 'P2003') {
      return res.status(400).json({
        error: 'Validation failed: A referenced entity (unit, department, or user) does not exist.',
        field: err.meta?.field_name
      });
    }

    console.error('[Agents Route] Error creating agent:', err.message);
    return res.status(500).json({
      error: 'An unexpected internal server error occurred while creating the agent.'
    });
  }
});


// UPDATE agent (Restricted to SUPER_ADMIN, ADMIN, HR, or self-update for personal details)
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;
  const currentUser = req.user;
  
  try {
    const agentRecord = await prisma.agent.findUnique({ where: { id } });
    if (!agentRecord) return res.status(404).json({ error: 'Agent not found' });

    const isElevated = currentUser && ['SUPER_ADMIN', 'ADMIN', 'HR'].includes(currentUser.role);
    const isSelf = currentUser && (currentUser.agentId === id || currentUser.userId === agentRecord.userId);

    if (!isElevated && !isSelf) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions to update this agent' });
    }

    // Non-elevated users cannot change their role or email
    if (!isElevated) {
      delete updateData.role;
      delete updateData.email;
    }

    // Extract user specific fields
    const userUpdate = {};
    if (updateData.email) userUpdate.email = updateData.email;
    if (updateData.role) {
      if (updateData.role === 'SUPER_ADMIN') {
        const existingSuperAdmin = await prisma.user.findFirst({
          where: { role: 'SUPER_ADMIN' }
        });
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

// DELETE agent (Soft Delete - Restricted to SUPER_ADMIN, ADMIN)
router.delete('/:id', requireRole(['SUPER_ADMIN', 'ADMIN']), async (req, res) => {
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
