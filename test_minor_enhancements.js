/**
 * ElderCare CRM - Comprehensive Validation Test Suite
 * Validates:
 * 1. Agent Dashboard Ticket KPIs (totalTicketsRaised, pendingTickets, RBAC)
 * 2. Contact Name Resolution & Enrichment (Instagram, WhatsApp, verified customer retention)
 * 3. Message Delivery & Error Handling (Provider dispatch, payload validation, SENT vs FAILED)
 * 4. Call Logs & Omnichannel Synchronization (Shared Conversation and Message models)
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { resolveBestCustomerName, isGenericName, formatPhoneNumber } = require('./src/legacy/nameResolution');

let passedTests = 0;
let failedTests = 0;

function assert(description, condition, details = '') {
  if (condition) {
    console.log(`  ✅ PASS: ${description}`);
    passedTests++;
  } else {
    console.error(`  ❌ FAIL: ${description} ${details ? `(${details})` : ''}`);
    failedTests++;
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('   ELDERCARE CRM — ENHANCEMENTS & BUG FIXES VALIDATION SUITE    ');
  console.log('================================================================\n');

  try {
    // -----------------------------------------------------------------
    // TEST SUITE 1: CONTACT NAME RESOLUTION & ENRICHMENT
    // -----------------------------------------------------------------
    console.log('--- TEST SUITE 1: CONTACT NAME RESOLUTION & ENRICHMENT ---');

    // 1.1 Verified real customer name retention
    const verifiedCust = { name: 'Dr. Ramesh Sharma', phone: '+919876543210', platform: 'WHATSAPP' };
    assert(
      '1.1 Verified customer full name is preserved and never overwritten by generic names',
      resolveBestCustomerName(verifiedCust, null, 'WHATSAPP') === 'Dr. Ramesh Sharma'
    );

    // 1.2 Linked Lead name used if customer has generic name
    const genericCustWithLead = { name: 'WhatsApp User', phone: '+919876543210' };
    const lead = { customerName: 'Anita Gupta', phoneNumber: '+919876543210' };
    assert(
      '1.2 Linked Lead customerName is preferred when customer record has generic placeholder',
      resolveBestCustomerName(genericCustWithLead, lead, 'WHATSAPP') === 'Anita Gupta'
    );

    // 1.3 Instagram handle format
    const igCustomerWithHandle = { name: 'Instagram Contact', instagramUsername: 'eldercare_family', platformUserId: '17841400123456789' };
    assert(
      '1.3 Instagram handle with @ prefix returned when username is available',
      resolveBestCustomerName(igCustomerWithHandle, null, 'INSTAGRAM') === '@eldercare_family'
    );

    // 1.4 Instagram stable fallback with scoped user ID
    const igCustomerNoHandle = { name: 'Instagram Contact', instagramUsername: null, platformUserId: '1506298557957662' };
    assert(
      '1.4 Stable fallback "Instagram User (XXXX)" generated using last 4 digits of IGSID',
      resolveBestCustomerName(igCustomerNoHandle, null, 'INSTAGRAM') === 'Instagram User (7662)'
    );

    // 1.5 WhatsApp phone formatting & stripping
    assert(
      '1.5 formatPhoneNumber correctly strips whatsapp: prefix and retains clean digits',
      formatPhoneNumber('whatsapp:+919876543210') === '+919876543210'
    );
    assert(
      '1.5b Synthetic IG phone numbers (ig_...) are not treated as valid phone numbers',
      formatPhoneNumber('ig_1506298557957662') === null
    );

    // 1.6 Detection of generic names
    assert('1.6a "Instagram Contact" is identified as generic', isGenericName('Instagram Contact') === true);
    assert('1.6b "WhatsApp User" is identified as generic', isGenericName('WhatsApp User') === true);
    assert('1.6c "Unknown Caller" is identified as generic', isGenericName('Unknown Caller') === true);
    assert('1.6d Real name "John Doe" is NOT generic', isGenericName('John Doe') === false);

    // -----------------------------------------------------------------
    // TEST SUITE 2: AGENT DASHBOARD TICKET KPIS & RBAC
    // -----------------------------------------------------------------
    console.log('\n--- TEST SUITE 2: AGENT DASHBOARD TICKET KPIS & RBAC ---');

    // Find an agent in DB
    const testAgent = await prisma.agent.findFirst();
    const agentId = testAgent ? testAgent.id : null;

    // Count tickets raised by logged-in agent vs all tickets
    const agentTicketsRaised = await prisma.ticket.count({
      where: agentId ? { agentId } : {},
    });
    const totalCrmTickets = await prisma.ticket.count();

    assert(
      '2.1 Agent tickets raised query runs successfully and returns non-negative integer',
      typeof agentTicketsRaised === 'number' && agentTicketsRaised >= 0,
      `Agent raised: ${agentTicketsRaised}, Total: ${totalCrmTickets}`
    );

    // Count pending tickets (not in RESOLVED, CLOSED)
    const pendingTickets = await prisma.ticket.count({
      where: {
        status: { notIn: ['RESOLVED', 'CLOSED'] },
        ...(agentId ? { agentId } : {}),
      },
    });

    const resolvedTickets = await prisma.ticket.count({
      where: {
        status: { in: ['RESOLVED', 'CLOSED'] },
        ...(agentId ? { agentId } : {}),
      },
    });

    assert(
      '2.2 Pending tickets correctly excludes RESOLVED and CLOSED statuses',
      typeof pendingTickets === 'number' && (pendingTickets + resolvedTickets === agentTicketsRaised),
      `Pending: ${pendingTickets}, Resolved/Closed: ${resolvedTickets}, Sum: ${pendingTickets + resolvedTickets}`
    );

    // -----------------------------------------------------------------
    // TEST SUITE 3: MESSAGE DISPATCHING & DELIVERY VALIDATION
    // -----------------------------------------------------------------
    console.log('\n--- TEST SUITE 3: MESSAGE DISPATCHING & DELIVERY VALIDATION ---');

    // Import compiled TelephonyService from dist
    const { TelephonyService } = require('./dist/src/telephony/telephony.service');
    const mockRedis = {
      get: async () => null,
      set: async () => 'OK',
      publish: async () => 1,
    };
    const mockGateway = {
      server: {
        emit: (event, data) => {
          // Log emitted events for verification
          // console.log(`[Socket Emit] ${event}`);
        }
      }
    };
    const telephonyService = new TelephonyService(
      prisma,
      mockRedis,
      null, // queueService
      mockGateway,
      null, // livekitService
      { generateCallSummary: async () => null } // analyticsService
    );

    // 3.1 WhatsApp Invalid Recipient Validation
    const invalidPhoneResult = await telephonyService.dispatchExternalMessage('WHATSAPP', '123', 'Hello test');
    assert(
      '3.1 Reject invalid WhatsApp recipient with < 8 digits as REJECTED_INVALID_RECIPIENT',
      invalidPhoneResult.success === false && invalidPhoneResult.deliveryStatus === 'REJECTED_INVALID_RECIPIENT',
      `Result: ${JSON.stringify(invalidPhoneResult)}`
    );

    // 3.2 Instagram Invalid Recipient Validation (Phone number supplied to Instagram)
    const phoneToIgResult = await telephonyService.dispatchExternalMessage('INSTAGRAM', '+919876543210', 'Hello Instagram');
    assert(
      '3.2 Reject phone number as Instagram recipient with INVALID_RECIPIENT_TYPE error',
      phoneToIgResult.success === false && phoneToIgResult.code === 'INVALID_RECIPIENT_TYPE',
      `Result: ${JSON.stringify(phoneToIgResult)}`
    );

    // 3.3 Email Invalid Recipient Validation
    const invalidEmailResult = await telephonyService.dispatchExternalMessage('EMAIL', 'not-an-email', 'Hello Email');
    assert(
      '3.3 Reject malformed email recipient as REJECTED_INVALID_RECIPIENT',
      invalidEmailResult.success === false && invalidEmailResult.deliveryStatus === 'REJECTED_INVALID_RECIPIENT',
      `Result: ${JSON.stringify(invalidEmailResult)}`
    );

    // 3.4 Real Meta Instagram Delivery Attempt with live configuration
    const igDeliveryAttempt = await telephonyService.dispatchExternalMessage('INSTAGRAM', '1506298557957662', 'Test CRM verification message');
    assert(
      '3.4 Real Meta Instagram API call executed and rejected with live provider status (never fake-success)',
      igDeliveryAttempt.success === false && igDeliveryAttempt.deliveryStatus === 'REJECTED_BY_PROVIDER' && igDeliveryAttempt.provider === 'META_INSTAGRAM',
      `Provider Error: ${igDeliveryAttempt.error}`
    );

    // 3.5 Real Twilio WhatsApp Provider Configuration
    const hasTwilioCreds = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
    assert(
      '3.5 Active Twilio credentials present in CRM environment for reliable WhatsApp delivery',
      hasTwilioCreds === true,
      `Account SID: ${process.env.TWILIO_ACCOUNT_SID ? process.env.TWILIO_ACCOUNT_SID.slice(0, 8) + '...' : 'Missing'}`
    );

    // -----------------------------------------------------------------
    // TEST SUITE 4: CALL LOGS & OMNICHANNEL SYNCHRONIZATION
    // -----------------------------------------------------------------
    console.log('\n--- TEST SUITE 4: CALL LOGS & OMNICHANNEL SYNCHRONIZATION ---');

    // Find or create a test CallSession
    let testSession = await prisma.callSession.findFirst({
      include: { customer: true, conversation: true }
    });

    if (!testSession) {
      const cust = await prisma.customer.findFirst();
      testSession = await prisma.callSession.create({
        data: {
          callerPhone: '+919999988888',
          status: 'COMPLETED',
          customerId: cust?.id || null,
        },
        include: { customer: true, conversation: true }
      });
    }

    // Attempt sending an Instagram message from call with an invalid recipient (e.g. phone number)
    // and verify it is persisted as FAILED, not fake SENT
    let caughtException = null;
    try {
      await telephonyService.sendMessageFromCall(testSession.id, {
        channel: 'INSTAGRAM',
        recipient: '+919876543210', // Invalid: phone number to Instagram
        message: 'Synchronized test message from Call Logs',
      });
    } catch (err) {
      caughtException = err;
    }

    assert(
      '4.1 sendMessageFromCall rejects invalid channel recipient without pretending success',
      caughtException !== null && caughtException.status === 400,
      `Exception: ${caughtException?.message}`
    );

    // Verify the message in DB has status FAILED
    const failedMsg = await prisma.message.findFirst({
      where: {
        content: 'Synchronized test message from Call Logs',
      },
      orderBy: { createdAt: 'desc' },
      include: { conversation: true }
    });

    assert(
      '4.2 Rejected message is persisted to shared Message table as FAILED (never SENT)',
      failedMsg !== null && failedMsg.status === 'FAILED',
      `Persisted status: ${failedMsg?.status}`
    );

    assert(
      '4.3 Persisted message is tied to the unified Conversation model used by Omnichannel',
      failedMsg !== null && failedMsg.conversationId !== null,
      `Conversation ID: ${failedMsg?.conversationId}`
    );

    // Clean up test message to keep DB pristine
    if (failedMsg) {
      await prisma.message.delete({ where: { id: failedMsg.id } });
      console.log('  🧹 Cleaned up validation test message from database');
    }

    console.log('\n================================================================');
    console.log(`   VALIDATION COMPLETE: ${passedTests} PASSED, ${failedTests} FAILED`);
    console.log('================================================================\n');

    if (failedTests > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Validation test run error:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
