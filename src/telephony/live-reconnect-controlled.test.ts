/**
 * CONTROLLED LIVE RECONNECT & SOCKET LIFECYCLE INTEGRATION TEST
 * Spins up an in-memory HTTP + Socket.IO server on an ephemeral port,
 * connects real socket.io-client instances over loopback TCP,
 * and validates handshake auth, invalid signature rejection,
 * multi-tab presence, and clean token rotation during reconnect.
 */

import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import * as jwt from 'jsonwebtoken';
import { TelephonyGateway } from './telephony.gateway';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkeyforerpsystem';

class MockPrisma {
  public agentStore = new Map<string, any>([
    [
      'agent-raghav-live',
      {
        id: 'agent-raghav-live',
        userId: 'user-raghav-live',
        name: 'Raghav Live',
        status: 'OFFLINE',
        socketId: null,
      },
    ],
  ]);

  public agent = {
    findFirst: async ({ where }: any) => {
      if (where.id) return this.agentStore.get(where.id) || null;
      if (where.socketId) {
        for (const a of this.agentStore.values()) {
          if (a.socketId === where.socketId) return a;
        }
      }
      if (where.OR) {
        for (const c of where.OR) {
          if (c.id && this.agentStore.has(c.id)) return this.agentStore.get(c.id);
          if (c.userId) {
            for (const a of this.agentStore.values()) {
              if (a.userId === c.userId) return a;
            }
          }
        }
      }
      return null;
    },
    findUnique: async ({ where }: any) => this.agentStore.get(where.id) || null,
    update: async ({ where, data }: any) => {
      const a = this.agentStore.get(where.id);
      const updated = { ...a, ...data };
      this.agentStore.set(where.id, updated);
      return updated;
    },
  };
}

async function runLiveControlledTest() {
  console.log(`\n${BOLD}${CYAN}=== RUNNING CONTROLLED LIVE WEBSOCKET RECONNECT TEST ===${RESET}\n`);

  const httpServer = createServer();
  const ioServer = new SocketIOServer(httpServer, {
    cors: { origin: '*' },
    transports: ['websocket'],
  });

  const prisma = new MockPrisma();
  const gateway = new TelephonyGateway({} as any, {} as any, prisma as any);
  gateway.afterInit(ioServer);
  (gateway as any).server = ioServer;

  // Bind gateway listeners to ioServer connections
  ioServer.on('connection', (socket) => {
    gateway.handleConnection(socket);

    socket.on('agent_login', (data) => gateway.handleAgentLogin(data, socket));
    socket.on('disconnect', () => gateway.handleDisconnect(socket));
  });

  // Listen on random available port
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address() as any;
  const port = address.port;
  const socketUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running on port ${port}`);

  try {
    // 1. Test live invalid signature rejection
    console.log('1. Connecting client with invalid signature token...');
    const invalidToken = jwt.sign(
      { sub: 'user-raghav-live', agentId: 'agent-raghav-live' },
      'wrong-secret-signature',
      { algorithm: 'HS256' }
    );

    const clientWithInvalidSig: ClientSocketType = ClientSocket(socketUrl, {
      transports: ['websocket'],
      auth: { token: invalidToken },
      reconnection: false,
    });

    const rejectionReceived = await new Promise<boolean>((resolve) => {
      clientWithInvalidSig.on('connect_error', (err) => {
        console.log(`  ${GREEN}✔ Handshake rejected as expected:${RESET} ${err.message}`);
        resolve(err.message.includes('INVALID_SIGNATURE'));
      });
      clientWithInvalidSig.on('connect', () => {
        resolve(false);
      });
    });

    if (!rejectionReceived) {
      throw new Error('Expected client with invalid signature to be rejected at handshake!');
    }
    clientWithInvalidSig.close();

    // 2. Connect Tab 1 with valid token
    console.log('2. Connecting Tab 1 with valid token...');
    let activeToken = jwt.sign(
      { sub: 'user-raghav-live', userId: 'user-raghav-live', agentId: 'agent-raghav-live', role: 'AGENT' },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    const tab1: ClientSocketType = ClientSocket(socketUrl, {
      transports: ['websocket'],
      auth: (cb) => cb({ token: activeToken }),
      reconnection: true,
    });

    await new Promise<void>((resolve, reject) => {
      tab1.on('connect', () => {
        console.log(`  ${GREEN}✔ Tab 1 connected with socketId:${RESET} ${tab1.id}`);
        tab1.emit('agent_login', { agentId: 'agent-raghav-live', name: 'Raghav Live' });
        resolve();
      });
      tab1.on('connect_error', reject);
    });

    // Wait 100ms for DB update
    await new Promise((r) => setTimeout(r, 100));
    let dbAgent = await prisma.agent.findUnique({ where: { id: 'agent-raghav-live' } });
    if (dbAgent.status !== 'AVAILABLE' || dbAgent.socketId !== tab1.id) {
      throw new Error(`Tab 1 login failed: status=${dbAgent.status}, socketId=${dbAgent.socketId}`);
    }
    console.log(`  ${GREEN}✔ Tab 1 registered: Raghav is AVAILABLE in DB${RESET}`);

    // 3. Connect Tab 2 with valid token within 2 seconds
    console.log('3. Connecting Tab 2 within 2 seconds...');
    const tab2: ClientSocketType = ClientSocket(socketUrl, {
      transports: ['websocket'],
      auth: (cb) => cb({ token: activeToken }),
      reconnection: true,
    });

    await new Promise<void>((resolve, reject) => {
      tab2.on('connect', () => {
        console.log(`  ${GREEN}✔ Tab 2 connected with socketId:${RESET} ${tab2.id}`);
        tab2.emit('agent_login', { agentId: 'agent-raghav-live', name: 'Raghav Live' });
        resolve();
      });
      tab2.on('connect_error', reject);
    });

    await new Promise((r) => setTimeout(r, 100));
    dbAgent = await prisma.agent.findUnique({ where: { id: 'agent-raghav-live' } });
    const activeSockets = gateway.getActiveSocketsForAgent('agent-raghav-live');
    if (activeSockets.length !== 2 || dbAgent.socketId !== tab2.id) {
      throw new Error(`Tab 2 multi-socket tracking failed: activeCount=${activeSockets.length}`);
    }
    console.log(`  ${GREEN}✔ Multi-socket verified: 2 active sockets tracked, primary is Tab 2 (${tab2.id})${RESET}`);

    // 4. Disconnect Tab 1: Verify Raghav remains AVAILABLE
    console.log('4. Disconnecting Tab 1 (simulating stale tab close or drop)...');
    tab1.disconnect();
    await new Promise((r) => setTimeout(r, 150));

    dbAgent = await prisma.agent.findUnique({ where: { id: 'agent-raghav-live' } });
    if (dbAgent.status !== 'AVAILABLE' || dbAgent.socketId !== tab2.id) {
      throw new Error(`Stale disconnect failed: Agent status was changed to ${dbAgent.status}!`);
    }
    console.log(`  ${GREEN}✔ Stale disconnect verified: Raghav REMAINS AVAILABLE on Tab 2!${RESET}`);

    // 5. Test Live Token Rotation & Reconnect on Tab 2
    console.log('5. Simulating token rotation and live reconnect on Tab 2...');
    const rotatedToken = jwt.sign(
      { sub: 'user-raghav-live', userId: 'user-raghav-live', agentId: 'agent-raghav-live', role: 'AGENT', rotated: true },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '2h' }
    );
    activeToken = rotatedToken;
    tab2.auth = { token: rotatedToken };

    // Force disconnect and reconnect
    const reconnected = await new Promise<boolean>((resolve) => {
      tab2.disconnect();
      tab2.connect();
      tab2.on('connect', () => {
        console.log(`  ${GREEN}✔ Tab 2 reconnected successfully with rotated token: socketId=${tab2.id}${RESET}`);
        resolve(true);
      });
      tab2.on('connect_error', (e) => {
        console.error('Reconnect failed:', e);
        resolve(false);
      });
    });

    if (!reconnected) {
      throw new Error('Controlled reconnect with rotated token failed!');
    }

    // 6. Clean disconnect Tab 2: Verify Raghav marked OFFLINE
    console.log('6. Disconnecting Tab 2 (final connection)...');
    tab2.disconnect();
    await new Promise((r) => setTimeout(r, 150));

    dbAgent = await prisma.agent.findUnique({ where: { id: 'agent-raghav-live' } });
    if (dbAgent.status !== 'OFFLINE' || dbAgent.socketId !== null) {
      throw new Error(`Final disconnect failed: Agent status=${dbAgent.status}`);
    }
    console.log(`  ${GREEN}✔ Final disconnect verified: Raghav cleanly marked OFFLINE in DB!${RESET}`);

    console.log(`\n${BOLD}${GREEN}=== CONTROLLED LIVE WEBSOCKET RECONNECT TEST COMPLETED SUCCESSFULLY! ===${RESET}\n`);
  } finally {
    ioServer.close();
    httpServer.close();
  }
}

runLiveControlledTest().catch((err) => {
  console.error(`\n${RED}${BOLD}CONTROLLED LIVE TEST FAILED:${RESET}`, err);
  process.exit(1);
});
