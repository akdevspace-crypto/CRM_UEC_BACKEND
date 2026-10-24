import assert from 'assert';

console.log('\n================================================================');
console.log('  LIVEKIT RECORDING ROOT CAUSE & RECOVERABLE STATE MACHINE TESTS');
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

  const mockCallSessions = new Map<string, any>();
  const recordingStartingInProgress = new Set<string>();
  const recordingRetryAttempts = new Map<string, number>();

  let egressApiCallCount = 0;
  let egressApiShouldFail = false;
  let egressApiErrorCode: any = null;
  let egressApiErrorMessage = '';
  let egressApiReturnEmptyId = false;

  const mockLivekitService = {
    startRoomRecording: async (roomName: string): Promise<string> => {
      egressApiCallCount++;
      if (egressApiShouldFail) {
        const err: any = new Error(egressApiErrorMessage || 'Egress failed');
        if (egressApiErrorCode) {
          err.status = egressApiErrorCode.status || 500;
          err.code = egressApiErrorCode.code || 'internal';
        }
        throw err;
      }
      if (egressApiReturnEmptyId) {
        return '' as any;
      }
      return `EG_${Date.now()}_test`;
    },
    getRoomParticipants: async (roomName: string) => {
      return [{ identity: 'agent_1' }, { identity: 'customer_1' }];
    }
  };

  const mockPrisma = {
    callSession: {
      findFirst: async ({ where }: any) => {
        for (const session of mockCallSessions.values()) {
          if (where.OR) {
            for (const cond of where.OR) {
              if (cond.livekitRoom && session.livekitRoom === cond.livekitRoom) return session;
              if (cond.reason && session.reason === cond.reason) return session;
              if (cond.id && session.id === cond.id) return session;
            }
          }
        }
        return null;
      },
      findUnique: async ({ where }: any) => {
        return mockCallSessions.get(where.id) || null;
      },
      update: async ({ where, data }: any) => {
        const session = mockCallSessions.get(where.id);
        if (session) {
          Object.assign(session, data);
          return session;
        }
        throw new Error(`Session ${where.id} not found`);
      }
    }
  };

  // Implementation under test matching TelephonyService.startLivekitRecording
  async function testStartLivekitRecording(callSid: string, roomName: string): Promise<{ success: boolean; reason?: string }> {
    if (!roomName && !callSid) return { success: false, reason: 'NO_IDENTIFIER' };
    const lookupKey = roomName || callSid;

    if (recordingStartingInProgress.has(lookupKey) || (callSid && recordingStartingInProgress.has(callSid))) {
      return { success: false, reason: 'IN_FLIGHT_DUPLICATE' };
    }

    const currentAttempts = recordingRetryAttempts.get(lookupKey) || (callSid ? recordingRetryAttempts.get(callSid) : 0) || 0;
    const MAX_RECORDING_RETRIES = 3;
    if (currentAttempts >= MAX_RECORDING_RETRIES) {
      return { success: false, reason: 'MAX_RETRIES_REACHED' };
    }

    const callSession = await mockPrisma.callSession.findFirst({
      where: {
        OR: [
          { livekitRoom: roomName },
          { reason: callSid },
          { id: callSid }
        ]
      }
    });

    if (!callSession) {
      return { success: false, reason: 'SESSION_NOT_FOUND' };
    }

    const isTerminal = ['ENDED', 'MISSED', 'CANCELLED', 'UNANSWERED', 'BUSY', 'FAILED', 'REJECTED'].includes(callSession.status);
    if (isTerminal) {
      return { success: false, reason: 'CALL_TERMINAL' };
    }

    if (callSession.recordingStatus === 'RECORDING' ||
        callSession.recordingStatus === 'PROCESSING' ||
        callSession.recordingStatus === 'READY' ||
        callSession.livekitEgressId) {
      return { success: false, reason: 'ALREADY_RECORDING_OR_READY' };
    }

    if (callSession.status === 'RINGING') {
      return { success: false, reason: 'STILL_RINGING' };
    }

    // Acquire lock and track attempt
    recordingStartingInProgress.add(lookupKey);
    if (callSid) recordingStartingInProgress.add(callSid);
    recordingRetryAttempts.set(lookupKey, currentAttempts + 1);
    if (callSid) recordingRetryAttempts.set(callSid, currentAttempts + 1);

    try {
      const egressId = await mockLivekitService.startRoomRecording(roomName);
      if (!egressId || typeof egressId !== 'string' || !egressId.trim()) {
        throw new Error(`LiveKit Egress returned empty egressId for room ${roomName}`);
      }

      await mockPrisma.callSession.update({
        where: { id: callSession.id },
        data: {
          recordingStatus: 'RECORDING',
          livekitEgressId: egressId,
          recordingStartedAt: new Date()
        }
      });
      return { success: true };
    } catch (e: any) {
      const errMsg = e.message || String(e);
      const isQuotaExceeded = /egress minutes exceeded|quota|limit exceeded|resource_exhausted/i.test(errMsg) || e.status === 429;

      if (isQuotaExceeded) {
        await mockPrisma.callSession.update({
          where: { id: callSession.id },
          data: {
            recordingStatus: 'NOT_AVAILABLE',
            livekitEgressId: null,
          }
        });
        return { success: false, reason: 'QUOTA_EXHAUSTED' };
      } else {
        await mockPrisma.callSession.update({
          where: { id: callSession.id },
          data: {
            recordingStatus: 'FAILED',
            livekitEgressId: null,
          }
        });
        return { success: false, reason: 'EGRESS_FAILED' };
      }
    } finally {
      recordingStartingInProgress.delete(lookupKey);
      if (callSid) recordingStartingInProgress.delete(callSid);
    }
  }

  function resetState() {
    mockCallSessions.clear();
    recordingStartingInProgress.clear();
    recordingRetryAttempts.clear();
    egressApiCallCount = 0;
    egressApiShouldFail = false;
    egressApiErrorCode = null;
    egressApiErrorMessage = '';
    egressApiReturnEmptyId = false;
  }

  // Test 1: Successful Egress creation and persistence
  try {
    resetState();
    const session = {
      id: 'sess-001',
      reason: 'call_test_001',
      livekitRoom: 'room_test_001',
      status: 'IN_PROGRESS',
      recordingStatus: null,
      livekitEgressId: null
    };
    mockCallSessions.set(session.id, session);

    const result = await testStartLivekitRecording('call_test_001', 'room_test_001');
    assert.strictEqual(result.success, true);
    assert.strictEqual(session.recordingStatus, 'RECORDING');
    assert(session.livekitEgressId && session.livekitEgressId.startsWith('EG_'));
    assert.strictEqual(egressApiCallCount, 1);
    pass('TEST 1: Valid Egress Job Started', `egressId=${session.livekitEgressId} status=RECORDING`);
  } catch (err) {
    fail('TEST 1', err);
  }

  // Test 2: Reject empty or missing egressId
  try {
    resetState();
    const session = {
      id: 'sess-002',
      reason: 'call_test_002',
      livekitRoom: 'room_test_002',
      status: 'IN_PROGRESS',
      recordingStatus: null,
      livekitEgressId: null
    };
    mockCallSessions.set(session.id, session);
    egressApiReturnEmptyId = true;

    const result = await testStartLivekitRecording('call_test_002', 'room_test_002');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'EGRESS_FAILED');
    assert.strictEqual(session.recordingStatus, 'FAILED');
    assert.strictEqual(session.livekitEgressId, null);
    pass('TEST 2: Empty Egress ID Rejection', 'Rejects empty egressId, transitions to FAILED, no false RECORDING');
  } catch (err) {
    fail('TEST 2', err);
  }

  // Test 3: Duplicate start prevention while in-flight
  try {
    resetState();
    const session = {
      id: 'sess-003',
      reason: 'call_test_003',
      livekitRoom: 'room_test_003',
      status: 'IN_PROGRESS',
      recordingStatus: null,
      livekitEgressId: null
    };
    mockCallSessions.set(session.id, session);

    // Simulate in-flight lock held
    recordingStartingInProgress.add('room_test_003');

    const result = await testStartLivekitRecording('call_test_003', 'room_test_003');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'IN_FLIGHT_DUPLICATE');
    assert.strictEqual(egressApiCallCount, 0); // Did not make redundant API call
    pass('TEST 3: In-Flight Lock Deduplication', 'Deduplicates concurrent requests while Egress start is in flight');
  } catch (err) {
    fail('TEST 3', err);
  }

  // Test 4: Recoverable retry after failure when call is still active
  try {
    resetState();
    const session = {
      id: 'sess-004',
      reason: 'call_test_004',
      livekitRoom: 'room_test_004',
      status: 'IN_PROGRESS',
      recordingStatus: null,
      livekitEgressId: null
    };
    mockCallSessions.set(session.id, session);

    // Attempt 1: Transient network failure
    egressApiShouldFail = true;
    egressApiErrorMessage = 'network timeout';
    const attempt1 = await testStartLivekitRecording('call_test_004', 'room_test_004');
    assert.strictEqual(attempt1.success, false);
    assert.strictEqual(session.recordingStatus, 'FAILED');

    // In-flight lock is released
    assert.strictEqual(recordingStartingInProgress.has('room_test_004'), false);

    // Attempt 2: Network recovered, retry succeeds!
    egressApiShouldFail = false;
    const attempt2 = await testStartLivekitRecording('call_test_004', 'room_test_004');
    assert.strictEqual(attempt2.success, true);
    assert.strictEqual(session.recordingStatus, 'RECORDING');
    assert(session.livekitEgressId !== null);
    assert.strictEqual(egressApiCallCount, 2);
    pass('TEST 4: Recoverable Retry After Failure', 'Allows safe retry on active call after transient failure');
  } catch (err) {
    fail('TEST 4', err);
  }

  // Test 5: Quota exhausted handling (HTTP 429 resource_exhausted)
  try {
    resetState();
    const session = {
      id: 'sess-005',
      reason: 'call_test_005',
      livekitRoom: 'room_test_005',
      status: 'IN_PROGRESS',
      recordingStatus: null,
      livekitEgressId: null
    };
    mockCallSessions.set(session.id, session);

    egressApiShouldFail = true;
    egressApiErrorMessage = 'Too Many Requests: egress minutes exceeded';
    egressApiErrorCode = { status: 429, code: 'resource_exhausted' };

    const result = await testStartLivekitRecording('call_test_005', 'room_test_005');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'QUOTA_EXHAUSTED');
    assert.strictEqual(session.recordingStatus, 'NOT_AVAILABLE');
    assert.strictEqual(session.livekitEgressId, null);
    assert.strictEqual(recordingStartingInProgress.has('room_test_005'), false);
    pass('TEST 5: Quota Exhaustion (HTTP 429)', 'Transitions cleanly to NOT_AVAILABLE without crashing or hanging');
  } catch (err) {
    fail('TEST 5', err);
  }

  // Test 6: Retry limit enforcement (max 3 attempts)
  try {
    resetState();
    const session = {
      id: 'sess-006',
      reason: 'call_test_006',
      livekitRoom: 'room_test_006',
      status: 'IN_PROGRESS',
      recordingStatus: null,
      livekitEgressId: null
    };
    mockCallSessions.set(session.id, session);
    egressApiShouldFail = true;
    egressApiErrorMessage = 'persistent 500 error';

    // Attempts 1, 2, 3 fail
    await testStartLivekitRecording('call_test_006', 'room_test_006');
    await testStartLivekitRecording('call_test_006', 'room_test_006');
    await testStartLivekitRecording('call_test_006', 'room_test_006');
    assert.strictEqual(egressApiCallCount, 3);

    // Attempt 4 should be rejected immediately due to max retries
    const attempt4 = await testStartLivekitRecording('call_test_006', 'room_test_006');
    assert.strictEqual(attempt4.success, false);
    assert.strictEqual(attempt4.reason, 'MAX_RETRIES_REACHED');
    assert.strictEqual(egressApiCallCount, 3); // No 4th call made
    pass('TEST 6: Max Retries Enforced', 'Limits attempts to 3 and prevents runaway retry loops');
  } catch (err) {
    fail('TEST 6', err);
  }

  // Test 7: Idempotency when already RECORDING or READY
  try {
    resetState();
    const session = {
      id: 'sess-007',
      reason: 'call_test_007',
      livekitRoom: 'room_test_007',
      status: 'IN_PROGRESS',
      recordingStatus: 'RECORDING',
      livekitEgressId: 'EG_already_active_123'
    };
    mockCallSessions.set(session.id, session);

    const result = await testStartLivekitRecording('call_test_007', 'room_test_007');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'ALREADY_RECORDING_OR_READY');
    assert.strictEqual(egressApiCallCount, 0);
    pass('TEST 7: Idempotency Preservation', 'Ignores start if session is already actively recording');
  } catch (err) {
    fail('TEST 7', err);
  }

  // Test 8: Refuses recording while call is still RINGING
  try {
    resetState();
    const session = {
      id: 'sess-008',
      reason: 'call_test_008',
      livekitRoom: 'room_test_008',
      status: 'RINGING',
      recordingStatus: null,
      livekitEgressId: null
    };
    mockCallSessions.set(session.id, session);

    const result = await testStartLivekitRecording('call_test_008', 'room_test_008');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'STILL_RINGING');
    assert.strictEqual(egressApiCallCount, 0);
    // Attempt counter should NOT have been incremented
    assert.strictEqual(recordingRetryAttempts.get('room_test_008') || 0, 0);
    pass('TEST 8: Refuses Recording on RINGING', 'Only records answered calls; RINGING does not consume retry quota');
  } catch (err) {
    fail('TEST 8', err);
  }

  // Test 9: Refuses recording if call has terminated
  try {
    resetState();
    const session = {
      id: 'sess-009',
      reason: 'call_test_009',
      livekitRoom: 'room_test_009',
      status: 'ENDED',
      recordingStatus: null,
      livekitEgressId: null
    };
    mockCallSessions.set(session.id, session);

    const result = await testStartLivekitRecording('call_test_009', 'room_test_009');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'CALL_TERMINAL');
    assert.strictEqual(egressApiCallCount, 0);
    pass('TEST 9: Terminal State Guard', 'Refuses recording start on ended or cancelled calls');
  } catch (err) {
    fail('TEST 9', err);
  }

  console.log(`\n================================================================`);
  console.log(`  ALL ${passed}/${total} LIVEKIT RECORDING TESTS PASSED!`);
  console.log('================================================================\n');
}

runTests().catch(err => {
  console.error('Test run failed:', err);
  process.exit(1);
});
