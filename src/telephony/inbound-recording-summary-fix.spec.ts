import { TelephonyService } from './telephony.service';
import { TelephonyGateway } from './telephony.gateway';
import { VobizProvider } from './providers/vobiz.provider';
import { AnalyticsService } from '../analytics/analytics.service';
import * as assert from 'assert';

console.log('\n================================================================');
console.log('  THREE CONFIRMED DEFECTS REGRESSION TEST SUITE                 ');
console.log('  (1. Call Recording, 2. Audio AI Summary, 3. Inbound Term)    ');
console.log('================================================================\n');

async function runTests() {
  let passed = 0;
  let total = 0;

  function pass(title: string, detail?: string) {
    passed++;
    total++;
    console.log(`  ✔ PASS [${title}] ${detail || ''}`);
  }

  function fail(title: string, err: any) {
    total++;
    console.error(`  ❌ FAIL [${title}]:`, err.message || err);
    throw err;
  }

  // Mock State
  const mockCallSessions: Map<string, any> = new Map();
  const mockCallAnalytics: Map<string, any> = new Map();
  const mockAgents: Map<string, any> = new Map();
  const emittedEvents: Array<{ event: string; data: any }> = [];

  mockAgents.set('agent-1', {
    id: 'agent-1',
    userId: 'user-1',
    name: 'Raghav',
    status: 'BUSY',
    activeCalls: 1,
    socketId: 'sock-1'
  });

  const mockPrisma: any = {
    callSession: {
      findFirst: async ({ where }: any) => {
        for (const session of mockCallSessions.values()) {
          if (where.OR) {
            for (const cond of where.OR) {
              if (cond.id && session.id === cond.id) return session;
              if (cond.reason && session.reason === cond.reason) return session;
              if (cond.livekitRoom && session.livekitRoom === cond.livekitRoom) return session;
            }
          }
          if (where.id && session.id === where.id) return session;
          if (where.reason && session.reason === where.reason) return session;
          if (where.status?.in && where.status.in.includes(session.status)) {
            if (where.customer?.phone?.contains) {
              const target = where.customer.phone.contains;
              if (session.customerPhone && session.customerPhone.includes(target)) return session;
            }
          }
        }
        return null;
      },
      findMany: async () => Array.from(mockCallSessions.values()),
      findUnique: async ({ where }: any) => {
        return mockCallSessions.get(where.id) || null;
      },
      update: async ({ where, data }: any) => {
        const session = mockCallSessions.get(where.id);
        if (session) {
          Object.assign(session, data);
          return session;
        }
        return data;
      },
      create: async ({ data }: any) => {
        const id = data.id || `sess-${Date.now()}`;
        const record = { id, ...data };
        mockCallSessions.set(id, record);
        return record;
      }
    },
    callAnalytics: {
      findFirst: async ({ where }: any) => {
        return mockCallAnalytics.get(where.callSessionId) || null;
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = mockCallAnalytics.get(where.callSessionId);
        if (existing) {
          const updated = { ...existing, ...update };
          mockCallAnalytics.set(where.callSessionId, updated);
          return updated;
        }
        const created = { id: `analytics-${Date.now()}`, ...create };
        mockCallAnalytics.set(where.callSessionId, created);
        return created;
      }
    },
    agent: {
      findFirst: async ({ where }: any) => {
        for (const a of mockAgents.values()) {
          if (where.OR) {
            for (const cond of where.OR) {
              if (cond.id && a.id === cond.id) return a;
              if (cond.userId && a.userId === cond.userId) return a;
            }
          }
          if (where.id && a.id === where.id) return a;
          if (where.userId && a.userId === where.userId) return a;
          if (where.socketId && a.socketId === where.socketId) return a;
        }
        return null;
      },
      findUnique: async ({ where }: any) => mockAgents.get(where.id) || mockAgents.get(where.userId) || null,
      update: async ({ where, data }: any) => {
        const a = mockAgents.get(where.id);
        if (a) {
          Object.assign(a, data);
          return a;
        }
        return data;
      }
    },
    callParticipant: {
      update: async () => ({})
    },
    callTransferAudit: {
      findMany: async () => []
    },
    aiUsageRecord: {
      create: async () => ({})
    }
  };

  const mockLivekitService: any = {
    startRoomRecording: async (roomName: string) => {
      // Simulate LiveKit cloud quota exhaustion
      throw new Error('egress minutes exceeded (code: resource_exhausted)');
    },
    stopRoomRecording: async () => ({}),
    terminateLiveKitCall: async () => 'terminated',
    generateAgentToken: async () => 'mock-token',
    getRoomParticipants: async () => [{ identity: 'agent' }, { identity: 'sip_customer' }]
  };

  const mockQueueService: any = {
    releaseReservation: async () => ({ released: true }),
    releaseAgentReservation: async (agentKey: string) => {
      const agent = mockAgents.get(agentKey) || Array.from(mockAgents.values()).find((a: any) => a.userId === agentKey);
      if (agent) {
        agent.activeCalls = Math.max(0, agent.activeCalls - 1);
        agent.status = agent.activeCalls === 0 ? 'AVAILABLE' : 'BUSY';
      }
      return { released: true };
    }
  };

  const mockCapacityService: any = {
    releaseChannel: async () => ({})
  };

  function createTelephonyService(analytics: any = null) {
    return new TelephonyService(
      mockPrisma,
      null as any, // redis
      mockQueueService,
      null as any, // telephonyGateway
      mockLivekitService,
      analytics,
      mockCapacityService
    );
  }

  // --- GROUP 1: Inbound Call Rejection & Termination ---
  console.log('--- GROUP 1: INBOUND CALL REJECTION & TERMINATION TESTS ---');

  // Test 1.1: Agent decline triggers rejectCall and sets status REJECTED
  try {
    const session1Id = '00000000-0000-0000-0000-000000000001';
    mockCallSessions.set(session1Id, {
      id: session1Id,
      reason: 'vobiz_call_001',
      livekitRoom: 'call_vobiz_001',
      status: 'RINGING',
      calleeUserId: 'user-1',
      participants: [{ id: 'p-1', agentId: 'agent-1' }]
    });

    const mockServer: any = {
      emit: (event: string, data: any) => emittedEvents.push({ event, data }),
      sockets: { sockets: new Map() }
    };

    const telephonyService = createTelephonyService();

    const gateway = new TelephonyGateway(
      telephonyService,
      mockLivekitService,
      mockPrisma
    );
    (gateway as any).server = mockServer;
    (telephonyService as any).telephonyGateway = gateway;

    const mockSocket: any = {
      id: 'sock-1',
      handshake: { auth: { agentId: 'agent-1' } },
      data: { user: { agentId: 'agent-1' } },
      emit: (event: string, data: any) => emittedEvents.push({ event, data })
    };

    // Emit rejectCall
    await gateway.handleRejectCall({ callSid: 'vobiz_call_001' }, mockSocket);

    const s1 = mockCallSessions.get(session1Id);
    assert.strictEqual(s1.status, 'REJECTED', 'CallSession status must transition to REJECTED');
    assert.strictEqual(mockAgents.get('agent-1').activeCalls, 0, 'Agent activeCalls must be decremented to 0');
    assert.strictEqual(mockAgents.get('agent-1').status, 'AVAILABLE', 'Agent status must transition to AVAILABLE');

    const callRejectedEvt = emittedEvents.find(e => e.event === 'callRejected');
    assert.ok(callRejectedEvt, 'callRejected event must be emitted');

    pass('1.1 Agent Decline Rejection', 'rejectCall sets status REJECTED, decrements activeCalls to 0, and restores AVAILABLE status');
  } catch (err) {
    fail('1.1 Agent Decline Rejection', err);
  }

  // Test 1.2: Inbound carrier webhook termination with alternate UUID correlation
  try {
    const session2Id = '00000000-0000-0000-0000-000000000002';
    mockCallSessions.set(session2Id, {
      id: session2Id,
      reason: 'vobiz_primary_uuid_999',
      livekitRoom: 'call_vobiz_primary_uuid_999',
      status: 'IN_PROGRESS',
      calleeUserId: 'user-1',
      customerPhone: '+919363341709',
      participants: [{ id: 'p-2', agentId: 'agent-1' }]
    });

    const vobizProvider = new VobizProvider(mockLivekitService);

    // Vobiz sends status callback where CallUUID is DialCallUUID or ALegUUID
    const carrierPayload = {
      CallUUID: 'vobiz_aleg_uuid_888',
      DialCallUUID: 'vobiz_primary_uuid_999', // Matches reason
      CallStatus: 'completed',
      Duration: '35',
      From: '+919363341709'
    };

    const normEvent = vobizProvider.normalizeWebhookEvent(carrierPayload, 'POST');
    assert.strictEqual(normEvent.eventType, 'CALL_ENDED', 'Event must normalize to CALL_ENDED');

    const telephonyService = createTelephonyService();
    (telephonyService as any).telephonyGateway = { server: { emit: () => {} } };

    await telephonyService.processNormalizedEvent(normEvent, { method: 'POST', body: carrierPayload });

    const s2 = mockCallSessions.get(session2Id);
    assert.strictEqual(s2.status, 'ENDED', 'Session correlated via DialCallUUID must end with status ENDED');
    assert.strictEqual(s2.duration, 35, 'Session duration must record 35 seconds');

    pass('1.2 Inbound Carrier Webhook Correlation', 'Inbound call correctly correlated via DialCallUUID candidate and terminated');
  } catch (err) {
    fail('1.2 Inbound Carrier Webhook Correlation', err);
  }

  // --- GROUP 2: Call Recording Quota Exhaustion & Status Transitions ---
  console.log('\n--- GROUP 2: CALL RECORDING LIFECYCLE & QUOTA HANDLING ---');

  // Test 2.1: Quota exhaustion caught gracefully without crashing call
  try {
    const session3Id = '00000000-0000-0000-0000-000000000003';
    mockCallSessions.set(session3Id, {
      id: session3Id,
      reason: 'rec_call_003',
      livekitRoom: 'room_rec_003',
      status: 'IN_PROGRESS',
      recordingStatus: 'PENDING'
    });

    const telephonyService = createTelephonyService();

    await telephonyService.startLivekitRecording('rec_call_003', 'room_rec_003');

    const s3 = mockCallSessions.get(session3Id);
    assert.strictEqual(s3.recordingStatus, 'NOT_AVAILABLE', 'Recording status must gracefully transition to NOT_AVAILABLE on quota exhaustion');
    assert.strictEqual(s3.status, 'IN_PROGRESS', 'Voice call must remain IN_PROGRESS despite recording quota failure');

    pass('2.1 Egress Quota Graceful Fallback', 'Recording status set to NOT_AVAILABLE, active call remains unhindered');
  } catch (err) {
    fail('2.1 Egress Quota Graceful Fallback', err);
  }

  // --- GROUP 3: Audio AI Summary & Sequencing Tests ---
  console.log('\n--- GROUP 3: AUDIO AI SUMMARY SEQUENCING & METADATA LABELS ---');

  // Test 3.1: Premature metadata summary blocked while egress is PROCESSING
  try {
    const session4Id = '00000000-0000-0000-0000-000000000004';
    let pipelineTriggered = false;

    mockCallSessions.set(session4Id, {
      id: session4Id,
      reason: 'call_egress_proc_004',
      livekitRoom: 'room_egress_proc_004',
      livekitEgressId: 'egress_12345',
      status: 'IN_PROGRESS',
      recordingStatus: 'PROCESSING',
      duration: 45
    });

    const mockAnalytics: any = {
      generateCallSummary: async () => {
        pipelineTriggered = true;
      }
    };

    const telephonyService = createTelephonyService(mockAnalytics);
    (telephonyService as any).telephonyGateway = { server: { emit: () => {} } };

    // When endCallSession is invoked while recordingStatus is 'PROCESSING', it should NOT trigger immediate metadata summary
    await telephonyService.endCallSession('call_egress_proc_004', 45, null, false, 'customer_hangup');

    assert.strictEqual(pipelineTriggered, false, 'Premature metadata summary must NOT trigger while egress is PROCESSING');

    pass('3.1 AI Pipeline Sequencing Guard', 'Metadata summary correctly deferred while LiveKit egress is PROCESSING');
  } catch (err) {
    fail('3.1 AI Pipeline Sequencing Guard', err);
  }

  // Test 3.2: Metadata fallback summary strictly labeled without audio transcript
  try {
    const session5Id = '00000000-0000-0000-0000-000000000005';
    mockCallSessions.set(session5Id, {
      id: session5Id,
      reason: 'call_meta_005',
      status: 'ENDED',
      duration: 28,
      recordingStatus: 'NOT_AVAILABLE',
      aiProcessingStatus: 'PENDING',
      customer: { name: 'Customer Test', phone: '+919363341709' }
    });

    const analyticsService = new AnalyticsService(mockPrisma);

    // Call generateCallSummary directly without audio
    await analyticsService.generateCallSummary(session5Id);

    const savedAnalytics = mockCallAnalytics.get(session5Id);
    assert.ok(savedAnalytics, 'CallAnalytics must be persisted');
    assert.strictEqual(savedAnalytics.aiHandling, false, 'aiHandling must be false when no audio exists');
    assert.strictEqual(savedAnalytics.transcript, null, 'transcript must be strictly null (never fabricated) for metadata fallback');
    assert.ok(
      savedAnalytics.summary.startsWith('[Metadata Summary - Audio Not Recorded]'),
      `Summary must be explicitly labeled [Metadata Summary - Audio Not Recorded], got: ${savedAnalytics.summary}`
    );

    pass('3.2 Metadata Fallback Explicit Labeling', 'Summary is strictly prefixed [Metadata Summary - Audio Not Recorded] and transcript is null');
  } catch (err) {
    fail('3.2 Metadata Fallback Explicit Labeling', err);
  }

  console.log('\n================================================================');
  console.log(`  ALL ${total}/${total} TARGETED DEFECT TESTS PASSED SUCCESSFULLY!`);
  console.log('================================================================\n');
}

runTests().catch(e => {
  console.error('Test suite failed:', e);
  process.exit(1);
});
