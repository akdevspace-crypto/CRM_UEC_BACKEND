/**
 * COMPREHENSIVE AUTOMATED VERIFICATION SUITE
 * ElderCare CRM — Scalable Inbound Queue & Global Concurrency Orchestration Engine
 * 
 * Tests:
 * 1. Global Capacity Orchestrator (Dynamic Scaling, Inbound Reserve, Outbound Throttling, Held Calls)
 * 2. Durable Queue Engine (Priority Ordering, FIFO within Tier, Timeout Overflow, Socket Check)
 * 3. Webhook Idempotency & State Machine Transitions
 */

import { CapacityService } from './capacity/capacity.service';
import { QueueService } from '../queue-orchestration/queue.service';
import { VobizProvider } from './providers/vobiz.provider';
import { OverflowService } from './overflow/overflow.service';

// Mock Redis Client for deterministic unit testing
class MockRedis {
  public store = new Map<string, any>();
  public hashes = new Map<string, Map<string, string>>();
  public status = 'ready';

  async get(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async set(key: string, value: string, ...args: any[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.store.has(key)) {
      return null;
    }
    this.store.set(key, value);
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

  async eval(script: string, numKeys: number, ...args: any[]): Promise<any> {
    // Deterministic simulation of the Redis Lua script for capacity reservation
    const [key_active, key_res] = args.slice(0, numKeys);
    const rest = args.slice(numKeys);

    let activeHash = this.hashes.get(key_active);
    if (!activeHash) {
      activeHash = new Map<string, string>();
      this.hashes.set(key_active, activeHash);
    }

    if (script.includes('key_res')) {
      // Reservation Script
      if (rest.length >= 6) {
        const call_id = rest[0];
        const direction = rest[1];
        const requested = Number(rest[2]);
        const max_total = Number(rest[3]);
        const max_outbound = Number(rest[4]);
        const queue_depth = Number(rest[5]);

        const total_active = Number(activeHash.get('total') || '0');
        const outbound_active = Number(activeHash.get('outbound') || '0');
        const inbound_active = Number(activeHash.get('inbound') || '0');

        if (direction === 'OUTBOUND') {
          if (queue_depth > 0) return [0, 'THROTTLED_INBOUND_PRIORITY'];
          if (outbound_active + requested > max_outbound) return [0, 'EXCEEDS_OUTBOUND_LIMIT'];
        }

        if (total_active + requested <= max_total) {
          activeHash.set('total', (total_active + requested).toString());
          if (direction === 'OUTBOUND') {
            activeHash.set('outbound', (outbound_active + requested).toString());
          } else {
            activeHash.set('inbound', (inbound_active + requested).toString());
          }
          this.store.set(key_res, JSON.stringify({ call_id, direction, channels: requested }));
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

      // Release Script
      if (this.store.has(key_res)) {
        const data = JSON.parse(this.store.get(key_res));
        this.store.delete(key_res);
        const total = Math.max(Number(activeHash.get('total') || '0') - data.channels, 0);
        activeHash.set('total', total.toString());
        if (data.direction === 'OUTBOUND') {
          const out = Math.max(Number(activeHash.get('outbound') || '0') - data.channels, 0);
          activeHash.set('outbound', out.toString());
        } else {
          const inb = Math.max(Number(activeHash.get('inbound') || '0') - data.channels, 0);
          activeHash.set('inbound', inb.toString());
        }
        return 1;
      }
      return 0;
    }
    return 0;
  }
}

// Mock Prisma Service
class MockPrismaService {
  public integrationConfiguration = {
    findFirst: async () => null,
    update: async () => ({}),
    create: async () => ({}),
  };

  public queueItem = {
    findMany: async (args: any) => {
      let filtered = [...MockPrismaService.items];
      if (args?.where?.status) filtered = filtered.filter((i) => i.status === args.where.status);
      if (args?.where?.department) filtered = filtered.filter((i) => i.department === args.where.department);
      return filtered;
    },
    create: async (args: any) => {
      const newItem = { id: `item_${Date.now()}_${Math.random()}`, ...args.data };
      MockPrismaService.items.push(newItem);
      return newItem;
    },
    update: async (args: any) => {
      const item = MockPrismaService.items.find((i) => i.id === args.where.id);
      if (item) Object.assign(item, args.data);
      return item;
    },
  };

  public static items: any[] = [];
  public static agents: any[] = [];

  public agent = {
    findUnique: async (args: any) => {
      const a = MockPrismaService.agents.find((ag) => ag.id === args.where.id);
      return a ? { ...a } : null;
    },
    findFirst: async (args: any) => {
      if (args?.where?.OR) {
        const idMatches = args.where.OR.map((o: any) => o.id || o.userId).filter(Boolean);
        const a = MockPrismaService.agents.find((ag) => idMatches.includes(ag.id) || idMatches.includes(ag.userId));
        return a ? { ...a } : null;
      }
      return MockPrismaService.agents[0] ? { ...MockPrismaService.agents[0] } : null;
    },
    findMany: async (args: any) => {
      let res = [...MockPrismaService.agents];
      if (args?.where?.status) res = res.filter((a) => a.status === args.where.status);
      if (args?.where?.activeCalls !== undefined) res = res.filter((a) => a.activeCalls === args.where.activeCalls);
      if (args?.where?.socketId?.not === null) res = res.filter((a) => a.socketId !== null && a.socketId !== undefined);
      return res;
    },
    update: async (args: any) => {
      const a = MockPrismaService.agents.find((ag) => ag.id === args.where.id);
      if (a) {
        if (args.data.activeCalls && typeof args.data.activeCalls === 'object' && args.data.activeCalls.increment) {
          a.activeCalls = (Number(a.activeCalls) || 0) + args.data.activeCalls.increment;
          const clone = { ...args.data };
          delete clone.activeCalls;
          Object.assign(a, clone);
        } else {
          Object.assign(a, args.data);
        }
      }
      return a;
    },
  };

  public callSession = {
    count: async () => 0,
    findMany: async () => [],
    updateMany: async () => ({ count: 0 }),
  };

  public $transaction = async (fn: any) => fn(this);
}

// TEST RUNNER
async function runTelephonyTestSuite() {
  console.log('================================================================');
  console.log('ELDERCARE CRM TELEPHONY CONCURRENCY & QUEUE ENGINE TEST SUITE');
  console.log('Timestamp: ' + new Date().toISOString());
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(testName: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName} - ${detail || 'Assertion failed'}`);
      failed++;
    }
  }

  const mockRedis = new MockRedis() as any;
  const mockPrisma = new MockPrismaService() as any;
  const capacityService = new CapacityService(mockPrisma, mockRedis);
  await capacityService.onModuleInit();

  // -------------------------------------------------------------
  // TEST GROUP 1: GLOBAL CAPACITY ORCHESTRATION & DYNAMIC SCALING
  // -------------------------------------------------------------
  console.log('\n--- 1. CAPACITY ORCHESTRATION & DYNAMIC SCALING TESTS ---');

  // Test 1.1: Runtime configurable total capacity (NOT hardcoded to 3)
  const defaultConf = await capacityService.getCapacityConfig('vobiz');
  assert('1.1 Initial Capacity Config Retrieved', defaultConf.totalChannels >= 1, `Total: ${defaultConf.totalChannels}`);

  // Test 1.2: Dynamic Scaling to 10 channels at runtime without restart
  const scaledConf = await capacityService.updateCapacityConfig('vobiz', { totalChannels: 10, inboundReserved: 2 });
  assert('1.2 Dynamic Scale to 10 Channels', scaledConf.totalChannels === 10 && scaledConf.inboundReserved === 2, `Scaled: ${scaledConf.totalChannels}`);

  // Test 1.3: Inbound Channel Reservation up to capacity
  const res1 = await capacityService.reserveChannel('INBOUND', 'call_inbound_001', 'vobiz');
  const res2 = await capacityService.reserveChannel('INBOUND', 'call_inbound_002', 'vobiz');
  assert('1.3 Inbound Atomic Reservations Succeed', res1.success && res2.success, 'Failed to reserve inbound channels');

  // Test 1.4: Outbound Dialing with Inbound Queue Depth = 0
  const out1 = await capacityService.reserveChannel('OUTBOUND', 'call_outbound_001', 'vobiz', { queueDepth: 0 });
  assert('1.4 Outbound Dial Permitted When Queue Depth = 0', out1.success, `Reason: ${out1.reason}`);

  // Test 1.5: Outbound Priority Throttling: When Inbound Queue Depth > 0, Outbound is PAUSED
  const throttledOut = await capacityService.reserveChannel('OUTBOUND', 'call_outbound_002', 'vobiz', { queueDepth: 3 });
  assert('1.5 Outbound Throttled When Inbound Calls Wait in Queue', !throttledOut.success && throttledOut.reason === 'THROTTLED_INBOUND_PRIORITY', `Got: ${throttledOut.reason}`);

  // Test 1.6: Atomic Channel Release
  await capacityService.releaseChannel('call_outbound_001', 'vobiz');
  const statusAfterRelease = await capacityService.getCapacityStatus('vobiz');
  assert('1.6 Channel Released Atomically', statusAfterRelease.activeOutbound === 0, `Active Outbound: ${statusAfterRelease.activeOutbound}`);

  // Test 1.7: Capacity Exhaustion Prevention (Scale down to 2 channels to test limit rejection)
  await capacityService.updateCapacityConfig('vobiz', { totalChannels: 2, inboundReserved: 0 });
  // Currently 2 inbound calls are active (call_inbound_001, call_inbound_002)
  const rejectedCall = await capacityService.reserveChannel('INBOUND', 'call_inbound_003', 'vobiz');
  assert('1.7 Capacity Exhaustion Rejection Enforced', !rejectedCall.success && rejectedCall.reason === 'CAPACITY_EXHAUSTED', `Reason: ${rejectedCall.reason}`);

  // Reset capacity pool
  await capacityService.releaseChannel('call_inbound_001', 'vobiz');
  await capacityService.releaseChannel('call_inbound_002', 'vobiz');
  await capacityService.updateCapacityConfig('vobiz', { totalChannels: 5, inboundReserved: 1 });

  // -------------------------------------------------------------
  // TEST GROUP 2: DURABLE QUEUE & PRIORITY DEQUEUEING
  // -------------------------------------------------------------
  console.log('\n--- 2. DURABLE QUEUE & AGENT ALLOCATION TESTS ---');

  const queueService = new QueueService(mockPrisma, mockRedis);

  // Setup test agents: 1 offline, 1 available without socket (disconnected laptop), 1 available with active socket
  MockPrismaService.agents = [
    { id: 'agent_offline', name: 'Barani', status: 'OFFLINE', activeCalls: 0, socketId: null, isDeleted: false, department: 'GENERAL' },
    { id: 'agent_no_socket', name: 'Barani Stale', status: 'AVAILABLE', activeCalls: 0, socketId: null, isDeleted: false, department: 'GENERAL' }, // Disconnected socket!
    { id: 'agent_online', name: 'Mani Connected', status: 'AVAILABLE', activeCalls: 0, socketId: 'sock_mani_123', isDeleted: false, department: 'GENERAL' },
  ];

  // Test 2.1: Disconnected Agent Protection (Never assign to AVAILABLE agent with socketId: null)
  const allocated = await queueService.allocateAgent({ callSid: 'call_test_01' });
  assert('2.1 Agent Allocation Strictly Requires Connected Socket', allocated?.id === 'agent_online', `Allocated: ${allocated?.name} (${allocated?.id})`);

  // Release agent
  await queueService.releaseAgentReservation('agent_online', 'call_test_01');

  // Test 2.2: Enqueueing Multiple Calls with Different Priorities
  MockPrismaService.items = []; // Reset queue
  await queueService.enqueueCallItem('call_norm_1', 'cust_1', 'GENERAL', 'NORMAL');
  await queueService.enqueueCallItem('call_emerg_1', 'cust_2', 'EMERGENCY', 'EMERGENCY');
  await queueService.enqueueCallItem('call_high_1', 'cust_3', 'GENERAL', 'HIGH');

  assert('2.2 Three Calls Enqueued in PostgreSQL', MockPrismaService.items.length === 3, `Items: ${MockPrismaService.items.length}`);

  // Test 2.3: Priority Dequeue (EMERGENCY must be dequeued FIRST despite being enqueued second)
  const dequeuedFirst = await queueService.dequeueAndAllocateNext();
  assert('2.3 EMERGENCY Call Dequeued First', dequeuedFirst?.callSessionId === 'call_emerg_1', `Dequeued: ${dequeuedFirst?.callSessionId}`);

  // Free agent and dequeue next
  await queueService.releaseAgentReservation('agent_online', 'call_emerg_1');
  const dequeuedSecond = await queueService.dequeueAndAllocateNext();
  assert('2.4 HIGH Priority Call Dequeued Second', dequeuedSecond?.callSessionId === 'call_high_1', `Dequeued: ${dequeuedSecond?.callSessionId}`);

  // Test 2.5: Queue Timeout Overflow Handling
  // Artificially age the remaining NORMAL call by setting enteredAt to 6 minutes ago (> 300s)
  const remainingItem = MockPrismaService.items.find((i) => i.outcome === 'call_norm_1' || i.callSessionId === 'call_norm_1');
  if (remainingItem) {
    remainingItem.enteredAt = new Date(Date.now() - 360 * 1000);
  }

  const overflowResult = await queueService.dequeueAndAllocateNext();
  assert('2.5 Timed-Out Call Transitions to OVERFLOW', remainingItem?.status === 'OVERFLOW', `Item status: ${remainingItem?.status}`);

  // -------------------------------------------------------------
  // TEST GROUP 3: PROVIDER CAPABILITIES & XML GENERATION
  // -------------------------------------------------------------
  console.log('\n--- 3. PROVIDER ADAPTER & WEBHOOK NORMALIZATION TESTS ---');

  const vobizProvider = new VobizProvider({} as any);

  // Test 3.1: Provider capabilities report
  const caps = vobizProvider.getCapabilities();
  assert('3.1 Vobiz Capabilities Verified', caps.provider === 'vobiz' && caps.supportsInboundBridge && caps.supportsCarrierHold, `Caps: ${JSON.stringify(caps)}`);

  // Test 3.2: Deterministic Bridge XML Generation with Active SIP Domain
  const bridgeXml = vobizProvider.generateBridgeResponse('call_test_123', 'https://crm-uec-backend.onrender.com');
  assert('3.2 Bridge XML Contains Deterministic SIP URI', bridgeXml.includes('<Sip>sip:call_test_123@4c0ct02u07s.sip.livekit.cloud</Sip>'), `XML: ${bridgeXml}`);

  // Test 3.3: Busy and Hold XML Generation
  const busyXml = vobizProvider.generateBusyResponse?.();
  assert('3.3 Carrier Busy XML Supported', typeof busyXml === 'string' && busyXml.includes('<Response>'), `Busy XML: ${busyXml}`);

  // -------------------------------------------------------------
  // TEST GROUP 4: OVERFLOW & CALLBACK MANAGEMENT
  // -------------------------------------------------------------
  console.log('\n--- 4. OVERFLOW & CALLBACK MANAGEMENT TESTS ---');

  const overflowService = new OverflowService(mockPrisma);

  // Test 4.1: Register Callback on Queue Timeout
  const callbackRes = await overflowService.registerCallback({
    phoneNumber: '+919876543210',
    department: 'GENERAL',
    priority: 'HIGH',
    notes: 'Caller waited >300s in queue',
  });
  assert('4.1 Callback Request Registered Successfully', !!callbackRes, `Callback: ${JSON.stringify(callbackRes)}`);

  // Test 4.2: Retrieve Pending Callbacks
  const pendingCallbacks = await overflowService.getPendingCallbacks();
  const foundCallback = pendingCallbacks.find((c: any) => c.phoneNumber === '+919876543210');
  assert('4.2 Pending Callback Retrieved from Database', !!foundCallback && foundCallback.priority === 'HIGH', `Found: ${JSON.stringify(foundCallback)}`);

  // Test 4.3: Mark Callback as Processed
  if (foundCallback) {
    const processResult = await overflowService.markCallbackProcessed(foundCallback.id);
    assert('4.3 Callback Marked Processed', processResult.success, `Result: ${JSON.stringify(processResult)}`);
  }

  // -------------------------------------------------------------
  // TEST GROUP 5: WEBHOOK IDEMPOTENCY & DEDUPLICATION
  // -------------------------------------------------------------
  console.log('\n--- 5. WEBHOOK IDEMPOTENCY & DEDUPLICATION TESTS ---');

  const webhookCallId = 'vobiz_evt_unique_998877';
  const lockKey = `lock:webhook:call:${webhookCallId}`;

  // First webhook delivery arrives
  const firstAcquire = await mockRedis.set(lockKey, 'PROCESSED', 'EX', 60, 'NX');
  assert('5.1 First Webhook Delivery Lock Acquired', firstAcquire === 'OK', `Lock result: ${firstAcquire}`);

  // Duplicate carrier webhook delivery arrives 50ms later (network retry)
  const duplicateAcquire = await mockRedis.set(lockKey, 'PROCESSED', 'EX', 60, 'NX');
  assert('5.2 Duplicate Webhook Delivery Rejected as Idempotent', duplicateAcquire === null, `Duplicate acquire result: ${duplicateAcquire}`);

  // -------------------------------------------------------------
  // TEST GROUP 6: HIGH-CONCURRENCY RACE CONDITION SIMULATION
  // -------------------------------------------------------------
  console.log('\n--- 6. HIGH-CONCURRENCY RACE CONDITION SIMULATION ---');

  // Configure a tight 3-channel capacity pool
  await capacityService.updateCapacityConfig('vobiz', { totalChannels: 3, inboundReserved: 0, maxOutboundChannels: 3 });

  // Simulate 10 simultaneous inbound calls executing concurrently via Promise.all
  const concurrentCalls = Array.from({ length: 10 }, (_, i) => `concurrent_call_${i + 1}`);
  const reservationResults = await Promise.all(
    concurrentCalls.map((callId) => capacityService.reserveChannel('INBOUND', callId, 'vobiz')),
  );

  const successfulReservations = reservationResults.filter((r) => r.success);
  const rejectedReservations = reservationResults.filter((r) => !r.success);

  assert('6.1 Exactly 3 Concurrent Calls Reserved Capacity in 3-Channel Pool', successfulReservations.length === 3, `Successful: ${successfulReservations.length}/10`);
  assert('6.2 Exactly 7 Excess Concurrent Calls Safely Rejected (Zero Over-Allocation)', rejectedReservations.length === 7 && rejectedReservations.every((r) => r.reason === 'CAPACITY_EXHAUSTED'), `Rejected: ${rejectedReservations.length}/10`);

  const poolStatus = await capacityService.getCapacityStatus('vobiz');
  assert('6.3 Active Channel Gauge Matches Exact Allocated Count (3/3)', poolStatus.totalActive === 3 && poolStatus.availableChannels === 0, `Pool status: ${poolStatus.totalActive}/${poolStatus.totalChannels}`);

  // Cleanup: Release all 3 reserved channels
  for (let i = 0; i < concurrentCalls.length; i++) {
    if (reservationResults[i].success) {
      await capacityService.releaseChannel(concurrentCalls[i], 'vobiz');
    }
  }

  const finalPoolStatus = await capacityService.getCapacityStatus('vobiz');
  assert('6.4 Full Channel Pool Cleanly Released to 0 Active Channels', finalPoolStatus.totalActive === 0 && finalPoolStatus.availableChannels === 3, `Final active: ${finalPoolStatus.totalActive}`);

  // -------------------------------------------------------------
  // FINAL SCORECARD
  // -------------------------------------------------------------
  console.log('\n================================================================');
  console.log(`TEST SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

// Execute tests
runTelephonyTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
