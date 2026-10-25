/**
 * PHASE 20 — DYNAMIC CAPACITY ORCHESTRATION TEST SUITE
 * Verifies removal of artificial channel limits, policy modes, ownership tokens, and non-destructive reconciliation
 */

import { CapacityService } from './capacity/capacity.service';

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
        let resHash = new Map<string, string>();
        resHash.set('call_id', call_id);
        resHash.set('direction', direction);
        resHash.set('channels', requested.toString());
        resHash.set('reservedAt', Date.now().toString());
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
  public activeSessions: any[] = [];
  public terminalSessions: any[] = [];

  public integrationConfiguration = {
    findFirst: async () => null,
    update: async () => ({}),
    create: async () => ({}),
  };

  public callSession = {
    findMany: async (args: any) => {
      if (args?.where?.status?.in?.includes('IN_PROGRESS')) {
        return this.activeSessions;
      }
      return this.terminalSessions;
    },
  };
}

async function runTests() {
  console.log('=== PHASE 20 DYNAMIC CAPACITY ORCHESTRATION TESTS ===\n');

  let passed = 0;
  let failed = 0;
  function assert(name: string, condition: boolean, msg?: string) {
    if (condition) {
      console.log(`[PASS] ${name}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name} - ${msg || 'Assertion failed'}`);
      failed++;
    }
  }

  const mockRedis = new MockRedis() as any;
  const mockPrisma = new MockPrisma() as any;
  const service = new CapacityService(mockPrisma, mockRedis);

  // Test 1: UNLIMITED_APPLICATION mode has no 3-channel cap
  await service.updateCapacityConfig('vobiz', { mode: 'UNLIMITED_APPLICATION', providerCpsLimit: 50 });
  const cfg = await service.getCapacityConfig('vobiz');
  assert('1.1 Mode is UNLIMITED_APPLICATION', cfg.mode === 'UNLIMITED_APPLICATION');

  // Reserve 10 simultaneous calls in UNLIMITED mode
  let allReserved = true;
  for (let i = 1; i <= 10; i++) {
    const res = await service.reserveChannel('OUTBOUND', `call_unlimited_${i}`, 'vobiz');
    if (!res.success) allReserved = false;
  }
  assert('1.2 Successfully reserved 10 concurrent outbound calls (no 3-channel limit)', allReserved);

  // Test 2: Emergency Priority in UNLIMITED mode
  const throttledEmergency = await service.reserveChannel('OUTBOUND', 'call_unlimited_emerg', 'vobiz', { emergencyDepth: 1 });
  assert('2.1 Outbound throttled when emergency depth > 0', !throttledEmergency.success && throttledEmergency.reason === 'THROTTLED_EMERGENCY_PRIORITY');

  // Test 3: Ownership token safety on release
  const dialA = await service.reserveChannel('OUTBOUND', 'call_ownership_test', 'vobiz');
  assert('3.1 Reservation has unique ownership token', !!dialA.reservationToken);

  // Attempt release with WRONG token
  const wrongRelease = await service.releaseChannel('call_ownership_test', 'vobiz', 'tok_wrong_older_call');
  assert('3.2 Older token release rejected (ownership protected)', !wrongRelease);

  // Release with CORRECT token
  const correctRelease = await service.releaseChannel('call_ownership_test', 'vobiz', dialA.reservationToken);
  assert('3.3 Correct token releases channel successfully', correctRelease);

  // Test 4: Non-destructive reconciliation keeps active calls
  mockPrisma.activeSessions = [
    { id: 'call_unlimited_1', reason: 'call_unlimited_1', livekitRoom: 'room_1', status: 'IN_PROGRESS' },
  ];
  mockPrisma.terminalSessions = [
    { id: 'call_unlimited_2', reason: 'call_unlimited_2', livekitRoom: 'room_2', status: 'ENDED' },
  ];

  await service.reconcileStaleReservations('vobiz');
  const statusAfterReconcile = await service.getCapacityStatus('vobiz');
  assert('4.1 Active DB call preserved during reconciliation', mockRedis.hashes.has('telephony:reservation:vobiz:call_unlimited_1'));
  assert('4.2 Ended call scavenged during reconciliation', !mockRedis.hashes.has('telephony:reservation:vobiz:call_unlimited_2'));

  console.log(`\nPHASE 20 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
