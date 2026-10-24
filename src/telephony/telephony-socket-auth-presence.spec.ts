/**
 * REGRESSION TEST SUITE: TELEPHONY WEBSOCKET AUTHENTICATION, PRESENCE & DETERMINISTIC DISPATCH
 * 
 * Verifies:
 * 1. Handshake authentication rejecting invalid signature with safe diagnostics
 * 2. Handshake authentication rejecting expired tokens
 * 3. Handshake authentication rejecting missing/empty tokens
 * 4. Handshake authentication accepting valid JWT and attaching claims
 * 5. Idempotent agent login (multiple emissions do not cause state flap or duplicate presence events)
 * 6. Multi-socket tracking (single agent connecting multiple sockets e.g. multi-tab or rapid reconnect)
 * 7. Stale socket disconnect resilience (closing socket-1 does NOT mark agent OFFLINE when socket-2 is alive)
 * 8. Final socket disconnect (closing all sockets marks agent OFFLINE)
 * 9. Token rotation during reconnect (dynamic auth updates and validates fresh token)
 * 10. Exactly-once deterministic call assignment (auto-routing stale socket targets to active socket)
 */

import * as jwt from 'jsonwebtoken';
import { TelephonyGateway } from './telephony.gateway';

// ANSI terminal colors
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
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

// Mock Prisma for deterministic gateway presence simulation
class MockPrismaService {
  public agents = new Map<string, any>();

  constructor() {
    this.agents.set('raghav-agent-id', {
      id: 'raghav-agent-id',
      userId: 'raghav-user-id',
      name: 'Raghav',
      department: 'ElderCare Specialists',
      status: 'OFFLINE',
      socketId: null,
      lastActive: new Date(),
      isDeleted: false,
      activeCalls: 0,
    });
  }

  public agent = {
    findUnique: async ({ where }: any) => {
      return this.agents.get(where.id) || null;
    },
    findFirst: async ({ where }: any) => {
      if (where.id) return this.agents.get(where.id) || null;
      if (where.socketId) {
        for (const a of this.agents.values()) {
          if (a.socketId === where.socketId) return a;
        }
      }
      if (where.OR) {
        for (const cond of where.OR) {
          if (cond.id && this.agents.has(cond.id)) return this.agents.get(cond.id);
          if (cond.userId) {
            for (const a of this.agents.values()) {
              if (a.userId === cond.userId) return a;
            }
          }
        }
      }
      return null;
    },
    update: async ({ where, data }: any) => {
      const existing = this.agents.get(where.id);
      if (!existing) throw new Error(`Agent not found: ${where.id}`);
      const updated = { ...existing, ...data };
      this.agents.set(where.id, updated);
      return updated;
    },
  };
}

// Mock Socket.IO Server & Socket
class MockSocket {
  public id: string;
  public connected: boolean = true;
  public handshake: any = { auth: {}, headers: {}, query: {} };
  public data: any = {};
  public emittedEvents: Array<{ event: string; data: any }> = [];

  constructor(id: string, auth: any = {}) {
    this.id = id;
    this.handshake.auth = auth;
  }

  emit(event: string, data: any) {
    this.emittedEvents.push({ event, data });
  }

  disconnect() {
    this.connected = false;
  }
}

class MockSocketServer {
  public sockets: { sockets: Map<string, MockSocket> } = {
    sockets: new Map<string, MockSocket>(),
  };
  public broadcastEvents: Array<{ event: string; data: any }> = [];
  public targetedEmits: Map<string, Array<{ event: string; data: any }>> = new Map();

  emit(event: string, data: any) {
    this.broadcastEvents.push({ event, data });
  }

  to(targetSocketId: string) {
    return {
      emit: (event: string, data: any) => {
        let list = this.targetedEmits.get(targetSocketId);
        if (!list) {
          list = [];
          this.targetedEmits.set(targetSocketId, list);
        }
        list.push({ event, data });
      },
    };
  }

  registerSocket(socket: MockSocket) {
    this.sockets.sockets.set(socket.id, socket);
  }

  removeSocket(socketId: string) {
    this.sockets.sockets.delete(socketId);
  }
}

async function runTestSuite() {
  console.log(`\n${BOLD}${CYAN}================================================================${RESET}`);
  console.log(`${BOLD}${CYAN}  ELDERCARE CRM — TELEPHONY GATEWAY WEBSOCKET REGRESSION SUITE  ${RESET}`);
  console.log(`${BOLD}${CYAN}================================================================${RESET}\n`);

  const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkeyforerpsystem';
  const prisma = new MockPrismaService();
  const server = new MockSocketServer();

  const gateway = new TelephonyGateway({} as any, {} as any, prisma as any);
  (gateway as any).server = server;

  // Run gateway initialization
  let middlewareFn: any = null;
  const mockServerAdapter = {
    use: (fn: any) => {
      middlewareFn = fn;
    },
  };
  gateway.afterInit(mockServerAdapter as any);

  assert(typeof middlewareFn === 'function', 'GATEWAY_INIT', 'Handshake auth middleware registered');

  // -------------------------------------------------------------
  // TEST 1: Handshake Authentication - Reject Invalid Signature
  // -------------------------------------------------------------
  console.log(`\n${YELLOW}--- Test 1: Invalid Signature Rejection ---${RESET}`);
  const badSecretToken = jwt.sign(
    { sub: 'raghav-user-id', agentId: 'raghav-agent-id', role: 'AGENT' },
    'completely-wrong-secret-key-1234',
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  const socketWithBadSig = new MockSocket('socket-bad-sig', { token: badSecretToken });
  let errorReturned: any = null;
  await middlewareFn(socketWithBadSig, (err?: any) => {
    errorReturned = err;
  });

  assert(Boolean(errorReturned), 'INVALID_SIGNATURE', 'Handshake rejected when token signature is invalid');
  assert(
    errorReturned?.message?.includes('INVALID_SIGNATURE'),
    'INVALID_SIGNATURE_CATEGORY',
    `Rejection message properly categorized: ${errorReturned?.message}`
  );
  assert(!socketWithBadSig.data.user, 'INVALID_SIGNATURE_NO_USER', 'No user claims attached to socket');

  // -------------------------------------------------------------
  // TEST 2: Handshake Authentication - Reject Expired Token
  // -------------------------------------------------------------
  console.log(`\n${YELLOW}--- Test 2: Expired Token Rejection ---${RESET}`);
  const expiredToken = jwt.sign(
    { sub: 'raghav-user-id', agentId: 'raghav-agent-id', role: 'AGENT' },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '-10s' }
  );

  const socketWithExpiredToken = new MockSocket('socket-expired', { token: expiredToken });
  let expiredError: any = null;
  await middlewareFn(socketWithExpiredToken, (err?: any) => {
    expiredError = err;
  });

  assert(Boolean(expiredError), 'EXPIRED_TOKEN', 'Handshake rejected when token is expired');
  assert(
    expiredError?.message?.includes('TOKEN_EXPIRED'),
    'EXPIRED_TOKEN_CATEGORY',
    `Rejection categorized as TOKEN_EXPIRED: ${expiredError?.message}`
  );

  // -------------------------------------------------------------
  // TEST 3: Handshake Authentication - Reject Missing Token
  // -------------------------------------------------------------
  console.log(`\n${YELLOW}--- Test 3: Missing Token Rejection ---${RESET}`);
  const socketWithNoToken = new MockSocket('socket-no-token', {});
  let noTokenError: any = null;
  await middlewareFn(socketWithNoToken, (err?: any) => {
    noTokenError = err;
  });

  assert(Boolean(noTokenError), 'MISSING_TOKEN', 'Handshake rejected when token is missing');
  assert(
    noTokenError?.message?.includes('AUTHENTICATION_REQUIRED'),
    'MISSING_TOKEN_CATEGORY',
    `Rejection message states AUTHENTICATION_REQUIRED: ${noTokenError?.message}`
  );

  // -------------------------------------------------------------
  // TEST 4: Handshake Authentication - Valid Token Verification
  // -------------------------------------------------------------
  console.log(`\n${YELLOW}--- Test 4: Valid Token Authentication ---${RESET}`);
  const validToken1 = jwt.sign(
    {
      sub: 'raghav-user-id',
      userId: 'raghav-user-id',
      agentId: 'raghav-agent-id',
      email: 'raghav@uec.com',
      role: 'AGENT',
      name: 'Raghav',
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '8h' }
  );

  const socketValid1 = new MockSocket('socket-raghav-tab1', { token: `Bearer ${validToken1}` });
  let validError: any = null;
  await middlewareFn(socketValid1, (err?: any) => {
    validError = err;
  });

  assert(!validError, 'VALID_TOKEN_AUTH', 'Valid token successfully verified by middleware');
  assert(
    socketValid1.data.user?.agentId === 'raghav-agent-id',
    'VALID_TOKEN_CLAIMS',
    `Authenticated claims correctly bound to socket.data.user: agentId=${socketValid1.data.user?.agentId}`
  );

  // Register in server mock
  server.registerSocket(socketValid1);
  gateway.handleConnection(socketValid1 as any);

  // -------------------------------------------------------------
  // TEST 5: Idempotent Agent Login
  // -------------------------------------------------------------
  console.log(`\n${YELLOW}--- Test 5: Idempotent Agent Login ---${RESET}`);
  await gateway.handleAgentLogin(
    { agentId: 'raghav-agent-id', name: 'Raghav' },
    socketValid1 as any
  );

  let raghavDb = await prisma.agent.findUnique({ where: { id: 'raghav-agent-id' } });
  assert(raghavDb?.status === 'AVAILABLE', 'LOGIN_STATUS', 'Agent Raghav status is AVAILABLE in database');
  assert(raghavDb?.socketId === 'socket-raghav-tab1', 'LOGIN_SOCKET', 'Database socketId updated to socket-raghav-tab1');

  const presenceBroadcastCountBefore = server.broadcastEvents.filter(
    (e) => e.event === 'agent_status_change' && e.data.status === 'AVAILABLE'
  ).length;

  // Duplicate agent_login emission on same socket
  await gateway.handleAgentLogin(
    { agentId: 'raghav-agent-id', name: 'Raghav' },
    socketValid1 as any
  );

  const presenceBroadcastCountAfter = server.broadcastEvents.filter(
    (e) => e.event === 'agent_status_change' && e.data.status === 'AVAILABLE'
  ).length;

  assert(
    presenceBroadcastCountBefore === presenceBroadcastCountAfter,
    'IDEMPOTENT_LOGIN',
    'Duplicate agent_login emission handled idempotently without spamming presence broadcast'
  );

  // -------------------------------------------------------------
  // TEST 6: Multiple Tabs / Sockets for Same Agent
  // -------------------------------------------------------------
  console.log(`\n${YELLOW}--- Test 6: Multi-Socket Tracking (Second Tab Connected) ---${RESET}`);
  const socketValid2 = new MockSocket('socket-raghav-tab2', { token: validToken1 });
  await middlewareFn(socketValid2, () => {});
  server.registerSocket(socketValid2);
  gateway.handleConnection(socketValid2 as any);

  await gateway.handleAgentLogin(
    { agentId: 'raghav-agent-id', name: 'Raghav' },
    socketValid2 as any
  );

  const activeSockets = gateway.getActiveSocketsForAgent('raghav-agent-id');
  assert(
    activeSockets.length === 2 && activeSockets.includes('socket-raghav-tab1') && activeSockets.includes('socket-raghav-tab2'),
    'MULTI_SOCKET_TRACKING',
    `Multi-socket registry tracks both active sockets: [${activeSockets.join(', ')}]`
  );

  raghavDb = await prisma.agent.findUnique({ where: { id: 'raghav-agent-id' } });
  assert(
    raghavDb?.socketId === 'socket-raghav-tab2',
    'MULTI_SOCKET_LATEST',
    'Database primary socketId points to latest connected active socket'
  );

  // -------------------------------------------------------------
  // TEST 7: Stale Socket Disconnect Resilience
  // -------------------------------------------------------------
  console.log(`\n${YELLOW}--- Test 7: Stale Socket Disconnect Resilience ---${RESET}`);
  // Tab 1 closes: socket-raghav-tab1 disconnects
  socketValid1.disconnect();
  server.removeSocket('socket-raghav-tab1');

  const offlineEventsBefore = server.broadcastEvents.filter(
    (e) => e.event === 'agent_status_change' && e.data.status === 'OFFLINE'
  ).length;

  await gateway.handleDisconnect(socketValid1 as any);

  raghavDb = await prisma.agent.findUnique({ where: { id: 'raghav-agent-id' } });
  const offlineEventsAfter = server.broadcastEvents.filter(
    (e) => e.event === 'agent_status_change' && e.data.status === 'OFFLINE'
  ).length;

  assert(
    raghavDb?.status === 'AVAILABLE',
    'STALE_DISCONNECT_PRESERVED',
    'Agent Raghav REMAINS AVAILABLE after socket-1 disconnects because socket-2 is alive'
  );
  assert(
    offlineEventsBefore === offlineEventsAfter,
    'NO_FALSE_OFFLINE_EVENT',
    'No OFFLINE status broadcast was emitted when a stale socket closed'
  );
  assert(
    raghavDb?.socketId === 'socket-raghav-tab2',
    'PRIMARY_SOCKET_MAINTAINED',
    `Database socketId retained active socket: ${raghavDb?.socketId}`
  );

  // -------------------------------------------------------------
  // TEST 8: Exactly-Once Deterministic Call Assignment
  // -------------------------------------------------------------
  console.log(`\n${YELLOW}--- Test 8: Deterministic Exactly-Once Call Assignment ---${RESET}`);
  const incomingCallPayload = {
    callSid: 'call_test_12345',
    roomName: 'room_test_12345',
    caller: '+919876543210',
    assignedAgent: { id: 'raghav-agent-id', name: 'Raghav' },
    token: 'livekit-agent-token',
  };

  // Dispatch targeting the old disconnected socket-1
  gateway.dispatchIncomingCallToAgent('socket-raghav-tab1', incomingCallPayload);

  const tab1Emits = server.targetedEmits.get('socket-raghav-tab1') || [];
  const tab2Emits = server.targetedEmits.get('socket-raghav-tab2') || [];

  assert(
    tab1Emits.filter((e) => e.event === 'incoming_call').length === 0,
    'NO_STALE_EMIT',
    'Stale/disconnected socket did NOT receive call emission'
  );
  assert(
    tab2Emits.filter((e) => e.event === 'incoming_call').length === 1,
    'REROUTED_TO_ACTIVE_SOCKET',
    'Call was deterministically re-routed and delivered exactly-once to active socket-2'
  );

  // -------------------------------------------------------------
  // TEST 9: Token Rotation During Reconnection
  // -------------------------------------------------------------
  console.log(`\n${YELLOW}--- Test 9: Token Rotation During Reconnect ---${RESET}`);
  const rotatedToken = jwt.sign(
    {
      sub: 'raghav-user-id',
      userId: 'raghav-user-id',
      agentId: 'raghav-agent-id',
      email: 'raghav@uec.com',
      role: 'AGENT',
      name: 'Raghav Rotated',
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '8h' }
  );

  // Reconnect with rotated token
  const socketRotated = new MockSocket('socket-raghav-reconnected', { token: rotatedToken });
  let rotationError: any = null;
  await middlewareFn(socketRotated, (err?: any) => {
    rotationError = err;
  });

  assert(!rotationError, 'TOKEN_ROTATION_SUCCESS', 'Reconnection with rotated access token verified successfully');
  assert(
    socketRotated.data.user?.name === 'Raghav Rotated',
    'ROTATED_CLAIMS_ATTACHED',
    `Updated claims attached to reconnected socket: ${socketRotated.data.user?.name}`
  );

  // -------------------------------------------------------------
  // TEST 10: Final Socket Disconnect Marks Agent OFFLINE
  // -------------------------------------------------------------
  console.log(`\n${YELLOW}--- Test 10: Final Socket Disconnect Marks OFFLINE ---${RESET}`);
  socketValid2.disconnect();
  server.removeSocket('socket-raghav-tab2');

  await gateway.handleDisconnect(socketValid2 as any);

  raghavDb = await prisma.agent.findUnique({ where: { id: 'raghav-agent-id' } });
  const finalOfflineEvents = server.broadcastEvents.filter(
    (e) => e.event === 'agent_status_change' && e.data.status === 'OFFLINE'
  );

  assert(
    raghavDb?.status === 'OFFLINE',
    'FINAL_DISCONNECT_OFFLINE',
    'Agent Raghav marked OFFLINE in database after all active sockets disconnect'
  );
  assert(
    raghavDb?.socketId === null,
    'SOCKET_ID_CLEARED',
    'Database socketId set to null upon final disconnect'
  );
  assert(
    finalOfflineEvents.length >= 1,
    'OFFLINE_EVENT_EMITTED',
    'agent_status_change OFFLINE broadcast emitted to notify contact center & supervisor dashboards'
  );

  console.log(`\n${BOLD}${GREEN}================================================================${RESET}`);
  console.log(`${BOLD}${GREEN}  ALL 10 VERIFICATION SUITES PASSED (${passedTests}/${totalTests} TESTS)  ${RESET}`);
  console.log(`${BOLD}${GREEN}================================================================${RESET}\n`);
}

runTestSuite().catch((err) => {
  console.error(`\n${RED}${BOLD}REGRESSION SUITE FAILED:${RESET}`, err);
  process.exit(1);
});
