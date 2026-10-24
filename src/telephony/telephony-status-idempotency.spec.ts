/**
 * REGRESSION TEST SUITE: AGENT STATUS EVENT DEDUPLICATION & IDEMPOTENCY (ISSUE A)
 * 
 * Verifies:
 * 1. Status update to identical status does NOT emit duplicate agent_status_change events (idempotent).
 * 2. Status update to a different status emits agent_status_change exactly once.
 * 3. Repeated status updates to the same target status only broadcast on first transition.
 * 4. Invalid status string is safely rejected without DB mutation or broadcast.
 * 5. Multi-socket presence: closing one tab does NOT mark agent OFFLINE or emit false OFFLINE events.
 * 6. Final socket disconnect marks agent OFFLINE and broadcasts OFFLINE exactly once.
 * 7. Legacy signaling separation: legacy signaling does not register competing presence listeners.
 */

import { TelephonyGateway } from './telephony.gateway';
import { AgentStatus } from '@prisma/client';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ${GREEN}✔ PASS${RESET} [${testName}] ${detail || ''}`);
  } else {
    console.error(`  ${RED}✖ FAIL${RESET} [${testName}] ${detail || ''}`);
    throw new Error(`Assertion failed: ${testName} - ${detail}`);
  }
}

async function runIdempotencySuite() {
  console.log(`\n================================================================`);
  console.log(`  ISSUE A: AGENT STATUS EVENT DEDUPLICATION & IDEMPOTENCY SUITE  `);
  console.log(`================================================================\n`);

  const emittedEvents: Array<{ event: string; data: any }> = [];

  const testAgent = {
    id: 'agent-dedup-1',
    userId: 'user-dedup-1',
    name: 'Barani Test',
    status: 'AVAILABLE' as AgentStatus,
    socketId: 'sock-1',
    lastActive: new Date(),
    isDeleted: false,
    activeCalls: 0,
  };

  const mockServer: any = {
    emit: (event: string, data: any) => {
      emittedEvents.push({ event, data });
    },
    to: () => ({
      emit: (event: string, data: any) => {
        emittedEvents.push({ event, data });
      },
    }),
    sockets: {
      sockets: new Map<string, any>(),
    },
  };

  let dbUpdateCalls: any[] = [];
  const mockPrisma: any = {
    agent: {
      findUnique: async () => ({ ...testAgent }),
      findFirst: async () => ({ ...testAgent }),
      update: async ({ data, where }: any) => {
        dbUpdateCalls.push({ data, where });
        if (data.status) testAgent.status = data.status;
        return { ...testAgent, ...data };
      },
    },
    user: {
      findUnique: async () => ({ id: testAgent.userId, email: 'barani@uec.com', role: 'AGENT' }),
    },
  };

  const mockRedis: any = {
    get: async () => JSON.stringify({ agentId: testAgent.id, status: testAgent.status, name: testAgent.name }),
    set: async () => 'OK',
    del: async () => 1,
  };

  const gateway = new TelephonyGateway({} as any, {} as any, mockPrisma as any, mockRedis as any);
  gateway.server = mockServer;

  // -------------------------------------------------------------
  // Test 1: Idempotent status update to identical status
  // -------------------------------------------------------------
  console.log('--- Test 1: Idempotent Status Update (No duplicate broadcast) ---');
  testAgent.status = 'AVAILABLE';
  emittedEvents.length = 0;
  dbUpdateCalls.length = 0;

  const mockSocket: any = { id: 'sock-1' };
  (gateway as any).socketToAgent.set('sock-1', { agentId: testAgent.id, name: testAgent.name });

  await gateway.handleStatusUpdate({ status: 'AVAILABLE' }, mockSocket);

  const statusEvents1 = emittedEvents.filter(e => e.event === 'agent_status_change');
  assert(statusEvents1.length === 0, 'STATUS_IDEMPOTENT_NO_BROADCAST', 'Zero broadcasts when status is already AVAILABLE');
  assert(dbUpdateCalls.length === 1 && !dbUpdateCalls[0].data.status, 'STATUS_IDEMPOTENT_NO_DB_STATUS_MUTATION', 'Only touched lastActive in DB, did not rewrite status');

  // -------------------------------------------------------------
  // Test 2: Status transition to new status emits exactly once
  // -------------------------------------------------------------
  console.log('\n--- Test 2: Valid Status Transition Emits Exactly Once ---');
  emittedEvents.length = 0;
  dbUpdateCalls.length = 0;

  await gateway.handleStatusUpdate({ status: 'BUSY' }, mockSocket);

  const statusEvents2 = emittedEvents.filter(e => e.event === 'agent_status_change');
  assert(statusEvents2.length === 1, 'STATUS_TRANSITION_EMITTED', 'Exactly 1 agent_status_change broadcast emitted');
  assert(statusEvents2[0].data.status === 'BUSY', 'STATUS_PAYLOAD_CORRECT', 'Broadcast status is BUSY');
  assert(statusEvents2[0].data.agentId === testAgent.id, 'STATUS_PAYLOAD_AGENT', 'Broadcast agentId is correct');
  assert(testAgent.status === 'BUSY', 'STATUS_DB_UPDATED', 'Agent status updated to BUSY in DB');

  // -------------------------------------------------------------
  // Test 3: Repeated calls with new status are suppressed
  // -------------------------------------------------------------
  console.log('\n--- Test 3: Repeated Calls Suppressed After First Transition ---');
  emittedEvents.length = 0;

  // Agent transitions to BREAK
  await gateway.handleStatusUpdate({ status: 'BREAK' }, mockSocket);
  assert(emittedEvents.filter(e => e.event === 'agent_status_change').length === 1, 'FIRST_TRANSITION_EMITTED', 'First call with BREAK emits broadcast');

  // Re-send BREAK 4 times (simulating duplicate socket events or aggressive polling)
  await gateway.handleStatusUpdate({ status: 'BREAK' }, mockSocket);
  await gateway.handleStatusUpdate({ status: 'BREAK' }, mockSocket);
  await gateway.handleStatusUpdate({ status: 'BREAK' }, mockSocket);
  await gateway.handleStatusUpdate({ status: 'BREAK' }, mockSocket);

  const totalBreakEvents = emittedEvents.filter(e => e.event === 'agent_status_change');
  assert(totalBreakEvents.length === 1, 'REDUNDANT_CALLS_SUPPRESSED', `Only 1 broadcast emitted across 5 calls (suppressed ${5 - 1} duplicate events)`);

  // -------------------------------------------------------------
  // Test 4: Invalid status string rejected safely
  // -------------------------------------------------------------
  console.log('\n--- Test 4: Invalid Status Rejection ---');
  emittedEvents.length = 0;
  testAgent.status = 'AVAILABLE';

  await gateway.handleStatusUpdate({ status: 'NON_EXISTENT_STATUS' as any }, mockSocket);
  assert(emittedEvents.length === 0, 'INVALID_STATUS_NO_BROADCAST', 'Invalid status string rejected without broadcast');
  assert(testAgent.status === 'AVAILABLE', 'INVALID_STATUS_NO_MUTATION', 'DB status remains unchanged');

  // -------------------------------------------------------------
  // Test 5: Multi-Socket Presence Isolation
  // -------------------------------------------------------------
  console.log('\n--- Test 5: Multi-Socket Disconnect Resilience ---');
  emittedEvents.length = 0;
  testAgent.status = 'AVAILABLE';

  const sock1: any = { id: 'sock-tab1', connected: true };
  const sock2: any = { id: 'sock-tab2', connected: true };
  mockServer.sockets.sockets.set('sock-tab1', sock1);
  mockServer.sockets.sockets.set('sock-tab2', sock2);

  (gateway as any).agentSockets.set(testAgent.id, new Set(['sock-tab1', 'sock-tab2']));
  (gateway as any).socketToAgent.set('sock-tab1', { agentId: testAgent.id, name: testAgent.name });
  (gateway as any).socketToAgent.set('sock-tab2', { agentId: testAgent.id, name: testAgent.name });

  // Tab 1 closes
  mockServer.sockets.sockets.delete('sock-tab1');
  await gateway.unregisterAgentSocket('sock-tab1');

  const falseOffline = emittedEvents.filter(
    e => e.event === 'agent_status_change' && e.data.status === 'OFFLINE'
  );
  assert(falseOffline.length === 0, 'NO_FALSE_OFFLINE_ON_PARTIAL_CLOSE', 'Closing Tab 1 does not broadcast OFFLINE when Tab 2 is active');

  // Tab 2 closes
  mockServer.sockets.sockets.delete('sock-tab2');
  await gateway.unregisterAgentSocket('sock-tab2');

  const finalOffline = emittedEvents.filter(
    e => e.event === 'agent_status_change' && e.data.status === 'OFFLINE'
  );
  assert(finalOffline.length === 1, 'FINAL_OFFLINE_EMITTED', 'Closing all sockets broadcasts OFFLINE exactly once');
  assert(finalOffline[0].data.agentId === testAgent.id, 'FINAL_OFFLINE_AGENT_ID', 'OFFLINE broadcast contains correct agentId');

  // -------------------------------------------------------------
  // Test 6: Legacy Signaling Competing Path Check
  // -------------------------------------------------------------
  console.log('\n--- Test 6: Competing Signaling Paths Verification ---');
  const signalingModule = require('../legacy/signaling');
  assert(typeof signalingModule.setupSignaling === 'function', 'SIGNALING_MODULE_EXISTS', 'legacy/signaling.js exports setupSignaling');

  // Verify that setting up signaling on an IO mock does NOT register competing agent_login or status_update
  const registeredEvents: string[] = [];
  const mockIo: any = {
    on: (evt: string, cb: any) => {
      if (evt === 'connection') {
        const dummySocket: any = {
          id: 'dummy-sock',
          on: (socketEvt: string) => {
            registeredEvents.push(socketEvt);
          },
        };
        cb(dummySocket);
      }
    },
  };

  signalingModule.setupSignaling(mockIo);
  assert(!registeredEvents.includes('agent_login'), 'NO_COMPETING_AGENT_LOGIN', 'legacy/signaling.js no longer registers competing agent_login');
  assert(!registeredEvents.includes('status_update'), 'NO_COMPETING_STATUS_UPDATE', 'legacy/signaling.js no longer registers competing status_update');
  assert(registeredEvents.includes('initiateCall'), 'WEBRTC_INITIATE_PRESERVED', 'WebRTC initiateCall signaling remains intact');
  assert(registeredEvents.includes('acceptCall'), 'WEBRTC_ACCEPT_PRESERVED', 'WebRTC acceptCall signaling remains intact');

  console.log(`\n${CYAN}================================================================${RESET}`);
  console.log(`  ${GREEN}ALL ${passedTests}/${totalTests} TESTS PASSED${RESET}`);
  console.log(`${CYAN}================================================================${RESET}\n`);
  process.exit(0);
}

runIdempotencySuite().catch(err => {
  console.error('\nSuite failed:', err);
  process.exit(1);
});

