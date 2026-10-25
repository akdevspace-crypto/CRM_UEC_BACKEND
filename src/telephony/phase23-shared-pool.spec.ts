/**
 * PHASE 23 — SHARED INBOUND/OUTBOUND CAPACITY POOL WITH AUTOMATIC CALL RESET
 * Comprehensive Automated Verification Suite covering all 8 Phase 23 requirements.
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
      const favor_inbound_last = Number(rest[9] || '0');

      const total_active = Number(activeHash.get('total') || '0');
      const outbound_active = Number(activeHash.get('outbound') || '0');
      const inbound_active = Number(activeHash.get('inbound') || '0');

      if (direction === 'OUTBOUND') {
        if (outbound_active + requested > max_outbound) return [0, 'EXCEEDS_OUTBOUND_LIMIT'];
        if (favor_inbound_last === 1 && (total_active + requested > max_total - 1)) {
          return [0, 'INSUFFICIENT_INBOUND_RESERVE'];
        }
        if (inbound_reserved > 0 && (total_active + requested > max_total - inbound_reserved)) {
          return [0, 'INSUFFICIENT_INBOUND_RESERVE'];
        }
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
        resHash.set('state', 'RESERVED');
        this.hashes.set(key_res, resHash);
        this.store.set(key_res, JSON.stringify({ call_id, direction, channels: requested, token, state: 'RESERVED' }));

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

    return null;
  }
}

class MockPrisma {
  public agents: any[] = [];
  public callSessions: any[] = [];
  public queueItems: any[] = [];
  public integrations: any[] = [];
  public queues: any[] = [{ id: 'q_general', name: 'General Queue', isActive: true }];

  async $transaction(cb: (prisma: any) => Promise<any>): Promise<any> {
    return await cb(this);
  }

  agent = {
    findFirst: async (args: any) => {
      if (args?.where?.OR) {
        return this.agents.find(a => 
          args.where.OR.some((clause: any) => {
            if (clause.id && a.id === clause.id) return true;
            if (clause.userId && a.userId === clause.userId) return true;
            return false;
          })
        ) || null;
      }
      if (args?.where?.id) {
        return this.agents.find((a) => a.id === args.where.id) || null;
      }
      if (args?.where?.status) {
        return this.agents.find((a) => a.status === args.where.status) || null;
      }
      return this.agents[0] || null;
    },
    findUnique: async (args: any) => {
      return this.agents.find((a) => a.id === args.where.id) || null;
    },
    findMany: async (args?: any) => {
      return this.agents;
    },
    update: async (args: any) => {
      const idx = this.agents.findIndex((a) => a.id === args.where.id);
      if (idx !== -1) {
        this.agents[idx] = { ...this.agents[idx], ...args.data };
        return this.agents[idx];
      }
      return null;
    },
    updateMany: async (args: any) => {
      return { count: 0 };
    },
  };

  callSession = {
    create: async (args: any) => {
      const session = { id: `cs_${Date.now()}_${Math.random()}`, ...args.data, participants: [] };
      this.callSessions.push(session);
      return session;
    },
    findFirst: async (args: any) => {
      if (args?.where?.OR) {
        for (const cond of args.where.OR) {
          const match = this.callSessions.find((c) =>
            (cond.id && c.id === cond.id) ||
            (cond.reason && c.reason === cond.reason) ||
            (cond.livekitRoom && c.livekitRoom === cond.livekitRoom),
          );
          if (match) return match;
        }
      }
      return this.callSessions[0] || null;
    },
    findUnique: async (args: any) => {
      return this.callSessions.find((c) => c.id === args.where.id) || null;
    },
    findMany: async (args?: any) => {
      if (args?.where?.status?.in) {
        return this.callSessions.filter((c) => args.where.status.in.includes(c.status));
      }
      return this.callSessions;
    },
    count: async (args?: any) => {
      if (args?.where?.status?.in) {
        return this.callSessions.filter((c) => args.where.status.in.includes(c.status)).length;
      }
      if (args?.where?.status) {
        return this.callSessions.filter((c) => c.status === args.where.status).length;
      }
      return this.callSessions.length;
    },
    update: async (args: any) => {
      const idx = this.callSessions.findIndex((c) => c.id === args.where.id);
      if (idx !== -1) {
        this.callSessions[idx] = { ...this.callSessions[idx], ...args.data };
        return this.callSessions[idx];
      }
      return null;
    },
  };

  queueItem = {
    findFirst: async (args: any) => {
      if (args?.where?.callSessionId) {
        return this.queueItems.find((q) => q.callSessionId === args.where.callSessionId) || null;
      }
      return this.queueItems[0] || null;
    },
    findMany: async (args?: any) => {
      if (args?.where?.status) {
        return this.queueItems.filter((q) => q.status === args.where.status);
      }
      return this.queueItems;
    },
    create: async (args: any) => {
      const item = { id: `qi_${Date.now()}_${Math.random()}`, ...args.data };
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
      for (let i = 0; i < this.queueItems.length; i++) {
        if (args.where?.callSessionId && this.queueItems[i].callSessionId === args.where.callSessionId) {
          this.queueItems[i] = { ...this.queueItems[i], ...args.data };
          count++;
        }
      }
      return { count };
    },
  };

  callParticipant = {
    update: async (args: any) => ({}),
  };

  callTransferAudit = {
    findMany: async () => [],
    update: async () => ({}),
  };

  queue = {
    count: async () => this.queues.length,
    findFirst: async () => this.queues[0] || null,
  };

  integrationConfiguration = {
    findFirst: async (args: any) => {
      return this.integrations.find((i) => i.provider === args?.where?.provider) || null;
    },
    update: async (args: any) => {
      const idx = this.integrations.findIndex((i) => i.id === args.where.id);
      if (idx !== -1) {
        this.integrations[idx] = { ...this.integrations[idx], ...args.data };
        return this.integrations[idx];
      }
      return null;
    },
    create: async (args: any) => {
      const item = { id: `int_${Date.now()}`, ...args.data };
      this.integrations.push(item);
      return item;
    },
  };
}

async function runPhase23Suite() {
  console.log('\n======================================================================');
  console.log('PHASE 23 VERIFICATION SUITE: SHARED 3-CHANNEL INBOUND/OUTBOUND POOL');
  console.log('======================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(description: string, condition: boolean) {
    if (condition) {
      console.log(`  [PASS] ${description}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${description}`);
      failed++;
    }
  }

  const mockRedis = new MockRedis() as any;
  const mockPrisma = new MockPrisma() as any;

  // Initialize CapacityService
  const capacityService = new CapacityService(mockPrisma, mockRedis);
  await capacityService.onModuleInit();

  // Initialize QueueService
  const queueService = new QueueService(mockPrisma, mockRedis);

  // Initialize TelephonyService
  const mockLivekit = {
    terminateLiveKitCall: async () => 'participant_removed',
    stopRoomRecording: async () => {},
  } as any;

  const mockGateway = {
    server: {
      emit: (event: string, data: any) => {},
    },
  } as any;

  const mockAnalytics = {
    generateCallSummary: async () => ({ summary: 'Test summary', sentiment: 'POSITIVE' }),
  } as any;

  const telephonyService = new TelephonyService(
    mockPrisma,
    mockRedis,
    queueService,
    mockGateway,
    mockLivekit,
    mockAnalytics,
    capacityService,
  );

  // Helper to reset CPS recentDials between rapid tests
  function resetCps() {
    (capacityService as any).recentDials = [];
  }

  // -------------------------------------------------------------------------
  // 1. DEFAULT CAPACITY & PRECEDENCE RULE VERIFICATION
  // -------------------------------------------------------------------------
  console.log('--- TEST 1: Default Shared 3-Channel Configuration & Precedence ---');
  const defaultConf = await capacityService.getCapacityConfig('vobiz');
  assert('Default configured capacity is 3 channels', defaultConf.totalChannels === 3);
  assert('Default max outbound channels is 3 (full shared pool)', defaultConf.maxOutboundChannels === 3);
  assert('Default inbound reserved is 0', defaultConf.inboundReserved === 0);
  assert('Default inbound priority policy is EQUAL_SHARED_POOL', defaultConf.inboundPriorityPolicy === 'EQUAL_SHARED_POOL');
  assert('Default favorInboundOnLastChannel is false', defaultConf.favorInboundOnLastChannel === false);

  // Test Precedence: A legacy DB setting with maxOutbound: 1 must be sanitized
  mockPrisma.integrations.push({
    id: 'int_vobiz',
    provider: 'VOBIZ',
    settings: {
      capacityConfig: {
        totalChannels: 3,
        maxOutboundChannels: 1, // Legacy obsolete limit
        inboundReserved: 0,
      },
    },
  });
  await mockRedis.del('telephony:capacity:config:vobiz');
  const sanitizedConf = await capacityService.getCapacityConfig('vobiz');
  assert('Precedence rule sanitizes legacy maxOutbound: 1 to totalChannels (3)', sanitizedConf.maxOutboundChannels === 3);

  // -------------------------------------------------------------------------
  // 2. THREE CONCURRENT OUTBOUND CALLS
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 2: Three Simultaneous Outbound Calls in Shared Pool ---');
  await capacityService.updateCapacityConfig('vobiz', { totalChannels: 3, inboundReserved: 0, maxOutboundChannels: 3, favorInboundOnLastChannel: false });
  await mockRedis.hmset('telephony:capacity:vobiz:active', { total: '0', inbound: '0', outbound: '0' });

  const out1 = await capacityService.reserveChannel('OUTBOUND', 'call_out_1', 'vobiz');
  const out2 = await capacityService.reserveChannel('OUTBOUND', 'call_out_2', 'vobiz');
  const out3 = await capacityService.reserveChannel('OUTBOUND', 'call_out_3', 'vobiz');

  assert('Outbound call 1 admitted successfully', out1.success === true);
  assert('Outbound call 2 admitted successfully', out2.success === true);
  assert('Outbound call 3 admitted successfully (no 1-outbound block)', out3.success === true);

  const status3Out = await capacityService.getCapacityStatus('vobiz');
  assert('Status reports activeOutbound = 3', status3Out.activeOutbound === 3);
  assert('Status reports totalActive = 3', status3Out.totalActive === 3);
  assert('Status reports occupiedChannels = 3', status3Out.occupiedChannels === 3);
  assert('Status reports availableChannels = 0', status3Out.availableChannels === 0);

  // -------------------------------------------------------------------------
  // 3. FOURTH CALL REJECTED BEYOND SHARED CAPACITY
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 3: Fourth Call Rejection Beyond Shared Capacity ---');
  const out4 = await capacityService.reserveChannel('OUTBOUND', 'call_out_4', 'vobiz');
  assert('Fourth outbound call rejected', out4.success === false);
  assert('Outbound rejection reason indicates capacity exhaustion or ceiling', out4.reason === 'CAPACITY_EXHAUSTED' || out4.reason === 'EXCEEDS_OUTBOUND_LIMIT');

  const in4 = await capacityService.reserveChannel('INBOUND', 'call_in_4', 'vobiz');
  assert('Fourth inbound call rejected beyond capacity', in4.success === false);
  assert('Inbound rejection reason is CAPACITY_EXHAUSTED', in4.reason === 'CAPACITY_EXHAUSTED');

  // -------------------------------------------------------------------------
  // 4. AUTOMATIC CALL-STATE RESET & CHANNEL RELEASE
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 4: Automatic Call-State Reset & Channel Release ---');
  const release1 = await capacityService.releaseChannel('call_out_1', 'vobiz', out1.reservationToken);
  assert('Channel released successfully', release1 === true);

  const statusAfterRel1 = await capacityService.getCapacityStatus('vobiz');
  assert('Status after 1 release: activeOutbound = 2', statusAfterRel1.activeOutbound === 2);
  assert('Status after 1 release: totalActive = 2', statusAfterRel1.totalActive === 2);
  assert('Status after 1 release: availableChannels = 1', statusAfterRel1.availableChannels === 1);

  // Duplicate release verification
  const dupRelease = await capacityService.releaseChannel('call_out_1', 'vobiz', out1.reservationToken);
  assert('Duplicate release returns false (idempotent)', dupRelease === false);
  const statusAfterDup = await capacityService.getCapacityStatus('vobiz');
  assert('Duplicate release does NOT decrement capacity further (still 2 occupied)', statusAfterDup.totalActive === 2);

  // Release out2 and out3
  await capacityService.releaseChannel('call_out_2', 'vobiz', out2.reservationToken);
  await capacityService.releaseChannel('call_out_3', 'vobiz', out3.reservationToken);
  const statusClean = await capacityService.getCapacityStatus('vobiz');
  assert('All channels free: availableChannels = 3', statusClean.availableChannels === 3);

  // -------------------------------------------------------------------------
  // 5. THREE CONCURRENT INBOUND CALLS
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 5: Three Simultaneous Inbound Calls in Shared Pool ---');
  const in1 = await capacityService.reserveChannel('INBOUND', 'call_in_1', 'vobiz');
  const in2 = await capacityService.reserveChannel('INBOUND', 'call_in_2', 'vobiz');
  const in3 = await capacityService.reserveChannel('INBOUND', 'call_in_3', 'vobiz');

  assert('Inbound call 1 admitted', in1.success === true);
  assert('Inbound call 2 admitted', in2.success === true);
  assert('Inbound call 3 admitted', in3.success === true);

  const status3In = await capacityService.getCapacityStatus('vobiz');
  assert('Status reports activeInbound = 3', status3In.activeInbound === 3);
  assert('Status reports activeOutbound = 0', status3In.activeOutbound === 0);
  assert('Status reports availableChannels = 0', status3In.availableChannels === 0);

  // -------------------------------------------------------------------------
  // 6. MIXED INBOUND AND OUTBOUND SHARING THE 3 SLOTS
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 6: Mixed Inbound and Outbound Concurrency ---');
  await capacityService.releaseChannel('call_in_3', 'vobiz', in3.reservationToken);
  const status2In = await capacityService.getCapacityStatus('vobiz');
  assert('After releasing in3: availableChannels = 1', status2In.availableChannels === 1);

  const outMixed = await capacityService.reserveChannel('OUTBOUND', 'call_out_mixed', 'vobiz');
  assert('Outbound call admitted into 3rd slot alongside 2 inbound calls', outMixed.success === true);

  const statusMixed = await capacityService.getCapacityStatus('vobiz');
  assert('Mixed status: activeInbound = 2', statusMixed.activeInbound === 2);
  assert('Mixed status: activeOutbound = 1', statusMixed.activeOutbound === 1);
  assert('Mixed status: totalActive = 3', statusMixed.totalActive === 3);
  assert('Mixed status: availableChannels = 0', statusMixed.availableChannels === 0);

  // Clean up mixed calls
  await capacityService.releaseChannel('call_in_1', 'vobiz');
  await capacityService.releaseChannel('call_in_2', 'vobiz');
  await capacityService.releaseChannel('call_out_mixed', 'vobiz');

  // -------------------------------------------------------------------------
  // 7. INBOUND PRIORITY POLICY ON CONTENTION (FINAL SLOT FAVORING INBOUND)
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 7: Inbound Priority Policy on Last Available Channel ---');
  resetCps();
  await capacityService.updateCapacityConfig('vobiz', {
    totalChannels: 3,
    favorInboundOnLastChannel: true,
    inboundPriorityPolicy: 'FAVOR_INBOUND_LAST_CHANNEL',
  });

  const pOut1 = await capacityService.reserveChannel('OUTBOUND', 'call_prio_out_1', 'vobiz');
  const pOut2 = await capacityService.reserveChannel('OUTBOUND', 'call_prio_out_2', 'vobiz');
  assert('Outbound call 1 admitted under priority policy', pOut1.success === true);
  assert('Outbound call 2 admitted under priority policy', pOut2.success === true);

  // 3rd outbound call attempts reservation when only 1 slot remains
  const pOut3 = await capacityService.reserveChannel('OUTBOUND', 'call_prio_out_3', 'vobiz');
  assert('Outbound call 3 paused due to inbound priority on final slot', pOut3.success === false);
  assert('Outbound call 3 rejection reason is INSUFFICIENT_INBOUND_RESERVE', pOut3.reason === 'INSUFFICIENT_INBOUND_RESERVE');

  // Verify active calls were NOT preempted
  const statusPrio = await capacityService.getCapacityStatus('vobiz');
  assert('Active outbound calls remain untouched (activeOutbound = 2)', statusPrio.activeOutbound === 2);

  // Inbound call arrives for the 3rd slot
  const pIn1 = await capacityService.reserveChannel('INBOUND', 'call_prio_in_1', 'vobiz');
  assert('Inbound call 1 successfully consumes the favored final channel', pIn1.success === true);

  const statusPrioFull = await capacityService.getCapacityStatus('vobiz');
  assert('Total active is now 3 (2 outbound + 1 inbound)', statusPrioFull.totalActive === 3);

  // 4th call is rejected
  const pIn2 = await capacityService.reserveChannel('INBOUND', 'call_prio_in_2', 'vobiz');
  assert('4th call rejected when all 3 channels occupied', pIn2.success === false && pIn2.reason === 'CAPACITY_EXHAUSTED');

  // Clean up
  await capacityService.releaseChannel('call_prio_out_1', 'vobiz');
  await capacityService.releaseChannel('call_prio_out_2', 'vobiz');
  await capacityService.releaseChannel('call_prio_in_1', 'vobiz');

  // -------------------------------------------------------------------------
  // 8. AUTHORITATIVE PROVIDER ACCOUNT LIMITS
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 8: Authoritative Provider Limits Lower Than App Total ---');
  resetCps();
  await capacityService.updateCapacityConfig('vobiz', {
    totalChannels: 3,
    favorInboundOnLastChannel: false,
    inboundPriorityPolicy: 'EQUAL_SHARED_POOL',
  });
  // Simulate provider having only 2 channels contracted
  process.env.VOBIZ_CHANNEL_CAPACITY = '2';
  await mockRedis.del('telephony:capacity:config:vobiz');

  const provConf = await capacityService.getCapacityConfig('vobiz');
  assert('Provider limit recognized as 2', provConf.providerLimit === 2);

  const provOut1 = await capacityService.reserveChannel('OUTBOUND', 'call_prov_1', 'vobiz');
  const provOut2 = await capacityService.reserveChannel('OUTBOUND', 'call_prov_2', 'vobiz');
  assert('Call 1 admitted within provider limit', provOut1.success === true);
  assert('Call 2 admitted within provider limit', provOut2.success === true);

  const provOut3 = await capacityService.reserveChannel('OUTBOUND', 'call_prov_3', 'vobiz');
  assert('Call 3 rejected because provider account limit is 2', provOut3.success === false && (provOut3.reason === 'CAPACITY_EXHAUSTED' || provOut3.reason === 'EXCEEDS_OUTBOUND_LIMIT'));

  const provStatus = await capacityService.getCapacityStatus('vobiz');
  assert('Status reports effectiveCapacity = 2', provStatus.effectiveCapacity === 2);
  assert('Status reports providerSource accurately', provStatus.providerSource.includes('VOBIZ_CHANNEL_CAPACITY: 2'));

  // Reset provider limit back to 3
  process.env.VOBIZ_CHANNEL_CAPACITY = '3';
  await capacityService.releaseChannel('call_prov_1', 'vobiz');
  await capacityService.releaseChannel('call_prov_2', 'vobiz');
  await mockRedis.del('telephony:capacity:config:vobiz');

  // -------------------------------------------------------------------------
  // 9. AUTOMATIC END-TO-END CALL SESSION RESET (TelephonyService)
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 9: Automatic End-to-End Call Session Reset ---');
  resetCps();
  // Create an agent and active session
  mockPrisma.agents = [{ id: 'agent_42', userId: 'agent_42', name: 'Dr. Jane Smith', status: 'BUSY', activeCalls: 1, socketId: 'sock_1' }];
  const testSession = await mockPrisma.callSession.create({
    data: {
      status: 'IN_PROGRESS',
      reason: 'call_lifecycle_test_sid',
      livekitRoom: 'room_lifecycle_test',
      startedAt: new Date(Date.now() - 30000),
      calleeUserId: 'agent_42',
      participants: [{ id: 'part_1', agentId: 'agent_42' }],
      transferHistory: { provider: 'vobiz' },
    },
  });

  // Reserve channel for this session
  await capacityService.reserveChannel('OUTBOUND', 'call_lifecycle_test_sid', 'vobiz');
  const capBeforeEnd = await capacityService.getCapacityStatus('vobiz');
  assert('Capacity occupied before call end: totalActive = 1', capBeforeEnd.totalActive === 1);

  // Trigger endCallSession with duration and reason (5th argument)
  await telephonyService.endCallSession('call_lifecycle_test_sid', 30, null, false, 'completed');

  const updatedSession = await mockPrisma.callSession.findUnique({ where: { id: testSession.id } });
  assert('CallSession transitioned to ENDED', updatedSession.status === 'ENDED');
  assert('CallSession recorded endedAt timestamp', Boolean(updatedSession.endedAt));
  assert('CallSession recorded valid duration', updatedSession.duration >= 0);

  const capAfterEnd = await capacityService.getCapacityStatus('vobiz');
  assert('Capacity reservation automatically released on call end: totalActive = 0', capAfterEnd.totalActive === 0);
  assert('Available shared channels restored to 3', capAfterEnd.availableChannels === 3);

  const updatedAgent = await mockPrisma.agent.findUnique({ where: { id: 'agent_42' } });
  assert('Agent activeCalls cleared to 0', updatedAgent.activeCalls === 0);
  assert('Agent status automatically reset to AVAILABLE', updatedAgent.status === 'AVAILABLE');

  // -------------------------------------------------------------------------
  // 10. NON-DESTRUCTIVE DISCONNECT (PSTN Preservation)
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 10: Non-Destructive Browser Disconnect (PSTN Preservation) ---');
  resetCps();
  const activePstnSession = await mockPrisma.callSession.create({
    data: {
      status: 'CONNECTED',
      reason: 'pstn_live_call_sid',
      livekitRoom: 'room_pstn_live',
      startedAt: new Date(),
    },
  });

  await capacityService.reserveChannel('INBOUND', 'pstn_live_call_sid', 'vobiz');
  // Simulate WebRTC browser disconnect event with duration 0 and reason 'webrtc_disconnected' (5th argument)
  await telephonyService.endCallSession('pstn_live_call_sid', 0, null, false, 'webrtc_disconnected');

  const preservedSession = await mockPrisma.callSession.findUnique({ where: { id: activePstnSession.id } });
  assert('PSTN call session preserved in CONNECTED state on webrtc_disconnected', preservedSession.status === 'CONNECTED');
  const capPreserved = await capacityService.getCapacityStatus('vobiz');
  assert('PSTN channel reservation preserved (not leaked or prematurely released)', capPreserved.totalActive === 1);

  // Clean up
  await capacityService.releaseChannel('pstn_live_call_sid', 'vobiz');

  console.log('\n======================================================================');
  console.log(`PHASE 23 TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('======================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase23Suite().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
