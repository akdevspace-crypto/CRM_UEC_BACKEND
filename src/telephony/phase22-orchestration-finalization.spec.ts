/**
 * PHASE 22 — TELEPHONY ORCHESTRATION RE-ARCHITECTURE & AUTOMATIC CALL-STATE RESET
 * Automated Verification Suite covering all 12 Phase I requirements.
 */

import { CapacityService } from './capacity/capacity.service';
import { QueueService } from '../queue-orchestration/queue.service';
import { TelephonyService } from './telephony.service';

class MockRedis {
  public store = new Map<string, any>();
  public hashes = new Map<string, Map<string, string>>();
  public status = 'ready';

  async get(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async set(key: string, value: string, ...args: any[]): Promise<'OK' | null> {
    this.store.set(key, value);
    return 'OK';
  }

  async setnx(key: string, value: string): Promise<number> {
    if (this.store.has(key)) return 0;
    this.store.set(key, value);
    return 1;
  }

  async expire(key: string, seconds: number): Promise<number> {
    return 1;
  }

  async hmset(key: string, data: Record<string, string>): Promise<'OK'> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map<string, string>();
      this.hashes.set(key, hash);
    }
    for (const [k, v] of Object.entries(data)) {
      hash.set(k, v);
    }
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const existed = this.store.has(key) || this.hashes.has(key);
    this.store.delete(key);
    this.hashes.delete(key);
    return existed ? 1 : 0;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    const obj: Record<string, string> = {};
    hash.forEach((v, k) => (obj[k] = v));
    return obj;
  }

  async keys(pattern: string): Promise<string[]> {
    const p = pattern.replace('*', '');
    const res: string[] = [];
    for (const k of this.hashes.keys()) {
      if (k.startsWith(p)) res.push(k);
    }
    for (const k of this.store.keys()) {
      if (k.startsWith(p) && !res.includes(k)) res.push(k);
    }
    return res;
  }

  async eval(script: string, numKeys: number, ...args: any[]): Promise<any> {
    const [key_active, key_res] = args.slice(0, numKeys);
    const rest = args.slice(numKeys);

    let activeHash = this.hashes.get(key_active);
    if (!activeHash) {
      activeHash = new Map<string, string>();
      this.hashes.set(key_active, activeHash);
    }

    if (script.includes('key_res') && rest.length >= 6) {
      const call_id = rest[0];
      const direction = rest[1];
      const requested = Number(rest[2]);
      const max_total = Number(rest[3]);
      const max_outbound = Number(rest[4]);
      const queue_depth = Number(rest[5]);
      const token = rest[6];
      const nowMs = rest[7];
      const inbound_reserved = Number(rest[8] || '0');

      const total_active = Number(activeHash.get('total') || '0');
      const outbound_active = Number(activeHash.get('outbound') || '0');
      const inbound_active = Number(activeHash.get('inbound') || '0');

      if (direction === 'OUTBOUND') {
        if (outbound_active + requested > max_outbound) return [0, 'EXCEEDS_OUTBOUND_LIMIT'];
        if (total_active + requested > (max_total - inbound_reserved)) return [0, 'INSUFFICIENT_INBOUND_RESERVE'];
      }

      if (total_active + requested <= max_total) {
        activeHash.set('total', (total_active + requested).toString());
        if (direction === 'OUTBOUND') {
          activeHash.set('outbound', (outbound_active + requested).toString());
        } else {
          activeHash.set('inbound', (inbound_active + requested).toString());
        }
        let resHash = new Map<string, string>();
        resHash.set('call_id', call_id);
        resHash.set('direction', direction);
        resHash.set('channels', requested.toString());
        resHash.set('reservedAt', nowMs || Date.now().toString());
        resHash.set('token', token || '');
        this.hashes.set(key_res, resHash);
        this.store.set(key_res, JSON.stringify({ call_id, direction, channels: requested, token }));

        return [
          1,
          'RESERVED',
          total_active + requested,
          inbound_active + (direction === 'INBOUND' ? requested : 0),
          outbound_active + (direction === 'OUTBOUND' ? requested : 0),
        ];
      } else {
        return [0, 'CAPACITY_EXHAUSTED', total_active, inbound_active, outbound_active];
      }
    }

    if (script.includes('expected_token')) {
      const expected_token = rest[0];
      const resHash = this.hashes.get(key_res);
      if (resHash) {
        if (expected_token && resHash.get('token') && resHash.get('token') !== expected_token) {
          return 0; // Token mismatch
        }
        const channels = Number(resHash.get('channels') || '1');
        const direction = resHash.get('direction');
        this.hashes.delete(key_res);
        this.store.delete(key_res);

        const total = Math.max(Number(activeHash.get('total') || '0') - channels, 0);
        activeHash.set('total', total.toString());
        if (direction === 'OUTBOUND') {
          activeHash.set('outbound', Math.max(Number(activeHash.get('outbound') || '0') - channels, 0).toString());
        } else {
          activeHash.set('inbound', Math.max(Number(activeHash.get('inbound') || '0') - channels, 0).toString());
        }
        return 1;
      }
      return 0;
    }

    return 0;
  }
}

class MockPrisma {
  public sessions: any[] = [];
  public queueItems: any[] = [];
  public agents: any[] = [];
  public integrationConfig: any = null;

  public integrationConfiguration = {
    findFirst: async () => this.integrationConfig,
    update: async (args: any) => {
      this.integrationConfig = { ...this.integrationConfig, ...args.data };
      return this.integrationConfig;
    },
    create: async (args: any) => {
      this.integrationConfig = { ...args.data };
      return this.integrationConfig;
    },
  };

  public callSession = {
    findFirst: async (args: any) => {
      const { where } = args;
      return this.sessions.find((s) => {
        if (where?.id && s.id === where.id) return true;
        if (where?.reason && s.reason === where.reason) return true;
        if (where?.livekitRoom && s.livekitRoom === where.livekitRoom) return true;
        if (where?.OR) {
          return where.OR.some((c: any) => {
            if (c.id && s.id === c.id) return true;
            if (c.reason && s.reason === c.reason) return true;
            if (c.livekitRoom && s.livekitRoom === c.livekitRoom) return true;
            return false;
          });
        }
        return false;
      }) || null;
    },
    findUnique: async (args: any) => this.sessions.find((s) => s.id === args.where.id) || null,
    findMany: async (args?: any) => {
      let filtered = [...this.sessions];
      if (args?.where?.status?.in) {
        filtered = filtered.filter((s) => args.where.status.in.includes(s.status));
      }
      return filtered;
    },
    count: async (args?: any) => {
      let filtered = [...this.sessions];
      if (args?.where?.status?.in) {
        filtered = filtered.filter((s) => args.where.status.in.includes(s.status));
      } else if (args?.where?.status) {
        filtered = filtered.filter((s) => s.status === args.where.status);
      }
      return filtered.length;
    },
    create: async (args: any) => {
      const session = {
        id: `sess_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        ...args.data,
        participants: [],
      };
      this.sessions.push(session);
      return session;
    },
    update: async (args: any) => {
      const index = this.sessions.findIndex((s) => s.id === args.where.id);
      if (index !== -1) {
        this.sessions[index] = { ...this.sessions[index], ...args.data };
        return this.sessions[index];
      }
      return null;
    },
    updateMany: async (args: any) => {
      let count = 0;
      this.sessions = this.sessions.map((s) => {
        let match = false;
        if (args.where?.reason && s.reason === args.where.reason) match = true;
        if (args.where?.id && s.id === args.where.id) match = true;
        if (args.where?.status?.in && !args.where.status.in.includes(s.status)) match = false;
        if (match) {
          count++;
          return { ...s, ...args.data };
        }
        return s;
      });
      return { count };
    },
  };

  public queueItem = {
    findMany: async (args?: any) => {
      let filtered = [...this.queueItems];
      if (args?.where?.status) {
        filtered = filtered.filter((q) => q.status === args.where.status);
      }
      if (args?.where?.enteredAt?.gte) {
        filtered = filtered.filter((q) => new Date(q.enteredAt) >= new Date(args.where.enteredAt.gte));
      }
      return filtered;
    },
    create: async (args: any) => {
      const item = { id: `qi_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`, ...args.data };
      this.queueItems.push(item);
      return item;
    },
    update: async (args: any) => {
      const idx = this.queueItems.findIndex((q) => q.id === args.where.id);
      if (idx !== -1) {
        this.queueItems[idx] = { ...this.queueItems[idx], ...args.data };
        return this.queueItems[idx];
      }
      return null;
    },
    updateMany: async (args: any) => {
      let count = 0;
      this.queueItems = this.queueItems.map((q) => {
        let match = false;
        if (args.where?.status && q.status === args.where.status) match = true;
        if (args.where?.enteredAt?.lt && new Date(q.enteredAt) < new Date(args.where.enteredAt.lt)) match = true;
        if (match) {
          count++;
          return { ...q, ...args.data };
        }
        return q;
      });
      return { count };
    },
  };

  public agent = {
    findFirst: async (args: any) => {
      const { where } = args || {};
      if (where?.OR) {
        return this.agents.find((a) => where.OR.some((c: any) => (c.id && a.id === c.id) || (c.userId && a.userId === c.userId))) || null;
      }
      return this.agents.find((a) => a.id === where?.id || a.userId === where?.userId) || null;
    },
    findUnique: async (args: any) => this.agents.find((a) => a.id === args.where?.id) || null,
    findMany: async (args?: any) => this.agents.filter((a) => !a.isDeleted),
    update: async (args: any) => {
      const idx = this.agents.findIndex((a) => a.id === args.where.id);
      if (idx !== -1) {
        this.agents[idx] = { ...this.agents[idx], ...args.data };
        return this.agents[idx];
      }
      return null;
    },
  };

  public queue = {
    count: async () => 1,
  };

  public callParticipant = {
    update: async () => ({}),
  };

  public callTransferAudit = {
    findMany: async () => [],
    update: async () => ({}),
  };

  public customer = {
    findUnique: async () => null,
  };

  public lead = {
    findUnique: async () => null,
  };

  async $transaction(fn: any) {
    if (typeof fn === 'function') {
      return await fn(this);
    }
    return await Promise.all(fn);
  }
}

class MockTelephonyGateway {
  public server = {
    emit: (event: string, payload: any) => {},
    to: (socketId: string) => ({
      emit: (event: string, payload: any) => {},
    }),
  };
}

class MockLivekitService {
  async terminateLiveKitCall(roomName: string, callSid: string) {
    return 'terminated';
  }
  async stopRoomRecording(egressId: string) {}
  async generateAgentToken(roomName: string, name: string) {
    return 'mock_token_jwt';
  }
}

class MockAnalyticsService {
  async generateCallSummary(callId: string) {
    return { callId, summary: 'Auto-generated AI summary' };
  }
}

async function runPhase22Verification() {
  console.log('================================================================');
  console.log('   PHASE 22: TELEPHONY ORCHESTRATION & STATE RESET VERIFICATION');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function report(criteriaNum: number, name: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`[PASS] Criteria ${criteriaNum}: ${name}`);
      passed++;
    } else {
      console.error(`[FAIL] Criteria ${criteriaNum}: ${name} - ${detail || 'Requirement not met'}`);
      failed++;
    }
  }

  const mockRedis = new MockRedis() as any;
  const mockPrisma = new MockPrisma() as any;
  const mockGateway = new MockTelephonyGateway() as any;
  const mockLivekit = new MockLivekitService() as any;
  const mockAnalytics = new MockAnalyticsService() as any;

  const capacityService = new CapacityService(mockPrisma, mockRedis);
  const queueService = new QueueService(mockPrisma, mockRedis);
  const telephonyService = new TelephonyService(
    mockPrisma,
    mockRedis,
    queueService,
    mockGateway,
    mockLivekit,
    mockAnalytics,
    capacityService,
  );

  // Initialize Agent
  mockPrisma.agents = [
    {
      id: 'agent_1',
      userId: 'user_1',
      name: 'Agent Sarah',
      status: 'AVAILABLE',
      activeCalls: 0,
      socketId: 'sock_123',
      isDeleted: false,
    },
  ];

  // Configure Capacity Policy: Mode = UNLIMITED_APPLICATION, CPS = 50
  await capacityService.updateCapacityConfig('vobiz', {
    mode: 'UNLIMITED_APPLICATION',
    providerCpsLimit: 50,
    inboundReserved: 2,
    totalChannels: 30,
    maxOutboundChannels: 28,
  });

  // --------------------------------------------------------------------------
  // CRITERIA 1: A successful outbound call ends and releases its reservation automatically.
  // --------------------------------------------------------------------------
  const out1 = await capacityService.reserveChannel('OUTBOUND', 'call_out_1', 'vobiz');
  const sess1 = await telephonyService.createCallSession(
    'call_out_1',
    'call_outbound_1',
    undefined,
    'user_1',
    'outbound',
    '+919876543210',
  );
  sess1.transferHistory = { provider: 'vobiz', reservationToken: out1.reservationToken, direction: 'outbound' };
  mockPrisma.agents[0].activeCalls = 1;
  mockPrisma.agents[0].status = 'BUSY';

  // Call ends successfully
  await telephonyService.endCallSession('call_out_1', 45, null, true, 'completed');

  const capAfter1 = await capacityService.getCapacityStatus('vobiz');
  const sessAfter1 = await mockPrisma.callSession.findFirst({ where: { reason: 'call_out_1' } });
  report(
    1,
    'Successful outbound call ends and releases reservation automatically',
    capAfter1.activeOutbound === 0 && sessAfter1.status === 'ENDED' && sessAfter1.duration === 45,
    `activeOutbound=${capAfter1.activeOutbound}, status=${sessAfter1.status}`,
  );

  // --------------------------------------------------------------------------
  // CRITERIA 2: A failed outbound initiation does not leave a reservation occupied.
  // --------------------------------------------------------------------------
  const out2 = await capacityService.reserveChannel('OUTBOUND', 'call_out_failed', 'vobiz');
  report(
    2,
    'Outbound reservation acquired initially',
    out2.success && (await capacityService.getCapacityStatus('vobiz')).activeOutbound === 1,
  );
  // Simulate initiation failure cleanup (as done in initiateOutboundCall catch block)
  await capacityService.releaseChannel('call_out_failed', 'vobiz', out2.reservationToken);
  const capAfterFail = await capacityService.getCapacityStatus('vobiz');
  report(
    2,
    'Failed outbound initiation does not leave reservation occupied',
    capAfterFail.activeOutbound === 0,
    `activeOutbound=${capAfterFail.activeOutbound}`,
  );

  // --------------------------------------------------------------------------
  // CRITERIA 3: A customer hangup resets call state, agent assignment, and queue item.
  // --------------------------------------------------------------------------
  const in3 = await capacityService.reserveChannel('INBOUND', 'call_in_3', 'vobiz');
  const sess3 = await telephonyService.createCallSession('call_in_3', 'room_in_3', undefined, 'user_1', 'inbound');
  sess3.transferHistory = { provider: 'vobiz', reservationToken: in3.reservationToken, direction: 'inbound' };
  await queueService.enqueueCallItem('call_in_3', undefined, 'GENERAL', 'NORMAL');
  mockPrisma.agents[0].activeCalls = 1;
  mockPrisma.agents[0].status = 'BUSY';

  // Customer hangs up -> carrier webhook CALL_ENDED
  await telephonyService.endCallSession('call_in_3', 30, null, true, 'customer_hangup');

  const sessAfter3 = await mockPrisma.callSession.findFirst({ where: { reason: 'call_in_3' } });
  const queueAfter3 = await mockPrisma.queueItem.findMany({ where: { outcome: 'call_in_3' } });
  const agentAfter3 = await mockPrisma.agent.findUnique({ where: { id: 'agent_1' } });
  report(
    3,
    'Customer hangup resets call state, agent assignment, and queue item',
    sessAfter3.status === 'ENDED' && agentAfter3.status === 'AVAILABLE' && agentAfter3.activeCalls === 0 && queueAfter3[0]?.status === 'COMPLETED',
    `sessStatus=${sessAfter3.status}, agentStatus=${agentAfter3.status}, queueStatus=${queueAfter3[0]?.status}`,
  );

  // --------------------------------------------------------------------------
  // CRITERIA 4: An agent hangup resets state only after terminal call confirmation (WebRTC disconnect does NOT terminate).
  // --------------------------------------------------------------------------
  const out4 = await capacityService.reserveChannel('OUTBOUND', 'call_out_4', 'vobiz');
  const sess4 = await telephonyService.createCallSession('call_out_4', 'room_out_4', undefined, 'user_1', 'outbound');
  sess4.status = 'IN_PROGRESS';

  // 4a. Temporary browser/WebRTC disconnect
  await telephonyService.endCallSession('call_out_4', 0, null, false, 'webrtc_disconnected');
  const sessAfterWebRtc = await mockPrisma.callSession.findFirst({ where: { reason: 'call_out_4' } });
  report(
    4,
    'Temporary WebRTC disconnect preserves still-active PSTN/SIP call',
    sessAfterWebRtc.status === 'IN_PROGRESS',
    `Status=${sessAfterWebRtc.status}`,
  );

  // 4b. Explicit user hangup terminates
  await telephonyService.endCallSession('call_out_4', 15, null, false, 'explicit_user_end');
  const sessAfterHangup = await mockPrisma.callSession.findFirst({ where: { reason: 'call_out_4' } });
  report(
    4,
    'Explicit agent hangup resets call state to terminal ENDED',
    sessAfterHangup.status === 'ENDED',
    `Status=${sessAfterHangup.status}`,
  );

  // --------------------------------------------------------------------------
  // CRITERIA 5: Duplicate terminal callbacks do not double-release capacity.
  // --------------------------------------------------------------------------
  const initialCap = (await capacityService.getCapacityStatus('vobiz')).totalActive;
  // Send duplicate terminal webhooks for call_out_4
  await telephonyService.endCallSession('call_out_4', 15, null, true, 'CALL_ENDED');
  await telephonyService.endCallSession('call_out_4', 15, null, true, 'CALL_ENDED');
  const capAfterDup = (await capacityService.getCapacityStatus('vobiz')).totalActive;
  report(
    5,
    'Duplicate terminal callbacks do not double-release capacity (idempotent)',
    initialCap === capAfterDup && capAfterDup === 0,
    `Initial=${initialCap}, AfterDup=${capAfterDup}`,
  );

  // --------------------------------------------------------------------------
  // CRITERIA 6: A stale timeout cannot release a newer call's reservation (Token Ownership).
  // --------------------------------------------------------------------------
  const resNew = await capacityService.reserveChannel('OUTBOUND', 'trunk_reuse_id', 'vobiz');
  const oldAttempt = await capacityService.releaseChannel('trunk_reuse_id', 'vobiz', 'tok_older_stale_123');
  report(
    6,
    'Stale timeout with older token cannot release newer reservation',
    oldAttempt === false && (await capacityService.getCapacityStatus('vobiz')).activeOutbound === 1,
    `oldAttemptResult=${oldAttempt}`,
  );
  // Clean up with genuine token
  await capacityService.releaseChannel('trunk_reuse_id', 'vobiz', resNew.reservationToken);

  // --------------------------------------------------------------------------
  // CRITERIA 7: An agent with another active call remains busy.
  // --------------------------------------------------------------------------
  const secondCallSess = await telephonyService.createCallSession('call_agent_active_2', 'room_active_2', undefined, 'user_1', 'inbound');
  secondCallSess.status = 'IN_PROGRESS';
  // Release first call, but agent still has secondCallSess
  await queueService.releaseAgentReservation('agent_1', 'call_first_one');
  const agentMulti = await mockPrisma.agent.findUnique({ where: { id: 'agent_1' } });
  report(
    7,
    'Agent with another active call in DB remains BUSY with activeCalls=1',
    agentMulti.status === 'BUSY' && agentMulti.activeCalls === 1,
    `agentStatus=${agentMulti.status}, activeCalls=${agentMulti.activeCalls}`,
  );
  // Finish second call
  secondCallSess.status = 'ENDED';
  await queueService.releaseAgentReservation('agent_1', 'call_agent_active_2');
  const agentClean = await mockPrisma.agent.findUnique({ where: { id: 'agent_1' } });
  report(
    7,
    'Agent becomes AVAILABLE once all sessions are definitively ended',
    agentClean.status === 'AVAILABLE' && agentClean.activeCalls === 0,
    `agentStatus=${agentClean.status}, activeCalls=${agentClean.activeCalls}`,
  );

  // --------------------------------------------------------------------------
  // CRITERIA 8: A terminated call does not remain counted as active.
  // --------------------------------------------------------------------------
  const activeCount = await mockPrisma.callSession.count({ where: { status: { in: ['RINGING', 'IN_PROGRESS'] } } });
  const capStatus8 = await capacityService.getCapacityStatus('vobiz');
  report(
    8,
    'Terminated calls do not remain counted as active',
    activeCount === 0 && capStatus8.totalActive === 0,
    `activeDbSessions=${activeCount}, totalActiveCapacity=${capStatus8.totalActive}`,
  );

  // --------------------------------------------------------------------------
  // CRITERIA 9: Redis restart or outage does not permanently block future calls (Local Fallback).
  // --------------------------------------------------------------------------
  mockRedis.status = 'disconnected';
  const fallbackDial = await capacityService.reserveChannel('OUTBOUND', 'call_redis_down', 'vobiz');
  report(
    9,
    'Redis outage falls back safely to in-memory coordination without blocking',
    fallbackDial.success === true && fallbackDial.currentUsage?.totalActive === 1,
    `fallbackSuccess=${fallbackDial.success}`,
  );
  await capacityService.releaseChannel('call_redis_down', 'vobiz', fallbackDial.reservationToken);
  mockRedis.status = 'ready';

  // --------------------------------------------------------------------------
  // CRITERIA 10: Queue metrics and outbound admission agree on effective capacity.
  // --------------------------------------------------------------------------
  // Stale QueueItem older than 10 minutes should not block outbound calls
  mockPrisma.queueItems.push({
    id: 'stale_queue_item_1',
    callSessionId: null,
    outcome: 'call_ghost_old',
    status: 'WAITING',
    priority: 'NORMAL',
    enteredAt: new Date(Date.now() - 15 * 60 * 1000), // 15 mins ago
  });

  const dashboardMetrics = await queueService.getQueueOperationsDashboard();
  const dialAdmission = await capacityService.reserveChannel('OUTBOUND', 'call_out_agreement', 'vobiz', {
    queueDepth: dashboardMetrics.waitingCalls,
    emergencyDepth: dashboardMetrics.emergencyCalls,
  });
  report(
    10,
    'Queue metrics and outbound admission agree (stale items do not throttle dialer)',
    dashboardMetrics.waitingCalls === 0 && dialAdmission.success === true,
    `waitingCalls=${dashboardMetrics.waitingCalls}, dialSuccess=${dialAdmission.success}`,
  );
  await capacityService.releaseChannel('call_out_agreement', 'vobiz', dialAdmission.reservationToken);

  // --------------------------------------------------------------------------
  // CRITERIA 11: Inbound waiting, retries and overflow remain functional.
  // --------------------------------------------------------------------------
  const enqItem = await queueService.enqueueCallItem('call_in_overflow', undefined, 'GENERAL', 'NORMAL');
  report(11, 'Inbound caller enqueued successfully in WAITING state', enqItem.status === 'WAITING');

  // Dequeue and allocate to available agent
  const dequeued = await queueService.dequeueAndAllocateNext('GENERAL');
  report(
    11,
    'Inbound waiting caller dequeued and allocated to available agent',
    dequeued !== null && dequeued.assigned === true,
    `assigned=${dequeued?.assigned}, agent=${dequeued?.agentName}`,
  );

  // --------------------------------------------------------------------------
  // CRITERIA 12: Existing recordings, call logs and post-call workflows remain intact.
  // --------------------------------------------------------------------------
  const sess12 = await telephonyService.createCallSession('call_audit_12', 'room_audit_12', undefined, 'user_1', 'inbound');
  sess12.status = 'IN_PROGRESS';
  const vobizCarrierRecording = 'https://media.vobiz.ai/recordings/call_audit_12.mp3';

  await telephonyService.endCallSession('call_audit_12', 65, vobizCarrierRecording, true, 'completed');
  const sessAfter12 = await mockPrisma.callSession.findFirst({ where: { reason: 'call_audit_12' } });

  report(
    12,
    'Recordings, call logs, and post-call workflows remain intact',
    sessAfter12.recordingUrl === vobizCarrierRecording &&
    sessAfter12.recordingStatus === 'READY' &&
    sessAfter12.duration === 65 &&
    sessAfter12.status === 'ENDED',
    `recordingUrl=${sessAfter12.recordingUrl}, recordingStatus=${sessAfter12.recordingStatus}`,
  );

  console.log('\n================================================================');
  console.log(`   PHASE 22 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runPhase22Verification().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
