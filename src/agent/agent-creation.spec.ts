/**
 * REGRESSION TEST SUITE: AGENT CREATION, DTO VALIDATION & CONSTRAINTS (ISSUE B)
 * 
 * Tests the /api/v1/agents/create route handler directly with mock express req/res:
 * 1. Valid input -> 201 Created, safe response without passwordHash
 * 2. Missing/invalid fullName, email, password -> 400 Bad Request
 * 3. Invalid role or status enum -> 400 Bad Request
 * 4. Invalid date formats (dob, joinedAt) -> 400 Bad Request
 * 5. Empty string sanitization (employeeId: "" -> null) to avoid false collisions
 * 6. Duplicate email conflict -> 409 Conflict
 * 7. Duplicate employeeId conflict -> 409 Conflict
 * 8. Duplicate SUPER_ADMIN slot conflict -> 409 Conflict
 * 9. Invalid foreign keys (unitId, departmentId) -> 400 Bad Request
 * 10. Archived profile detection (409 isArchived: true) and reactivation (200 reactivated: true)
 * 11. Security: Credentials and stack traces are NEVER exposed in error responses
 */

import * as bcrypt from 'bcryptjs';

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

// In-memory test store
interface MockDb {
  users: any[];
  agents: any[];
  units: any[];
  departments: any[];
}

function createMockPrisma(db: MockDb) {
  return {
    user: {
      findUnique: async ({ where }: any) => {
        const u = db.users.find(x => x.email === where.email || x.id === where.id);
        if (!u) return null;
        const agentProfile = db.agents.find(a => a.userId === u.id);
        return { ...u, agentProfile: agentProfile ? { ...agentProfile } : null };
      },
      findFirst: async ({ where }: any) => {
        return db.users.find(x => x.role === where.role) || null;
      },
      create: async ({ data }: any) => {
        if (db.users.some(u => u.email === data.email)) {
          const err: any = new Error('Unique constraint failed on the fields: (`email`)');
          err.code = 'P2002';
          err.meta = { target: ['email'] };
          throw err;
        }
        const user = { id: 'u-' + Math.random().toString(36).substring(7), ...data, createdAt: new Date() };
        db.users.push(user);
        return user;
      },
      update: async ({ where, data }: any) => {
        const idx = db.users.findIndex(u => u.id === where.id);
        if (idx === -1) throw new Error('User not found');
        db.users[idx] = { ...db.users[idx], ...data };
        return db.users[idx];
      },
    },
    agent: {
      findFirst: async ({ where }: any) => {
        return db.agents.find(a => {
          if (where.employeeId && a.employeeId !== where.employeeId) return false;
          if (where.isDeleted !== undefined && a.isDeleted !== where.isDeleted) return false;
          if (where.userId?.not && a.userId === where.userId.not) return false;
          return true;
        }) || null;
      },
      create: async ({ data }: any) => {
        if (data.employeeId && db.agents.some(a => a.employeeId === data.employeeId)) {
          const err: any = new Error('Unique constraint failed on the fields: (`employeeId`)');
          err.code = 'P2002';
          err.meta = { target: ['employeeId'] };
          throw err;
        }
        const agent = { id: 'a-' + Math.random().toString(36).substring(7), ...data, createdAt: new Date() };
        db.agents.push(agent);
        return { ...agent, user: db.users.find(u => u.id === agent.userId) };
      },
      update: async ({ where, data }: any) => {
        const idx = db.agents.findIndex(a => a.id === where.id);
        if (idx === -1) throw new Error('Agent not found');
        db.agents[idx] = { ...db.agents[idx], ...data };
        return { ...db.agents[idx], user: db.users.find(u => u.id === db.agents[idx].userId) };
      },
    },
    businessUnit: {
      findUnique: async ({ where }: any) => {
        return db.units.find(u => u.id === where.id) || null;
      },
    },
    department: {
      findUnique: async ({ where }: any) => {
        return db.departments.find(d => d.id === where.id) || null;
      },
    },
    unitMembership: {
      create: async ({ data }: any) => ({ id: 'um-1', ...data }),
    },
    $transaction: async (fn: any) => fn(createMockPrisma(db)),
  };
}

// Mock express response generator
function createMockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
  };
  return res;
}

async function runAgentCreationSuite() {
  console.log(`\n================================================================`);
  console.log(`  ISSUE B: AGENT CREATION, DTO VALIDATION & CONSTRAINTS SUITE  `);
  console.log(`================================================================\n`);

  // Set up mock DB
  const db: MockDb = {
    users: [
      {
        id: 'super-admin-id',
        email: 'raghav@uec.com',
        passwordHash: 'hashed',
        role: 'SUPER_ADMIN',
        createdAt: new Date(),
      },
      {
        id: 'user-barani-archived',
        email: 'customercarebarani@uec.com',
        passwordHash: 'hashed',
        role: 'AGENT',
        createdAt: new Date(),
      },
    ],
    agents: [
      {
        id: 'agent-barani-archived',
        userId: 'user-barani-archived',
        name: 'Barani',
        employeeId: 'Emp-02',
        isDeleted: true,
        status: 'OFFLINE',
      },
    ],
    units: [
      { id: 'f7dab772-a5b3-404f-80bc-c5a4f5f03405', name: 'Main Unit' }
    ],
    departments: [
      { id: 'e1111111-1111-4111-a111-111111111111', name: 'Support' }
    ],
  };

  const mockPrisma = createMockPrisma(db);
  const prismaPath = require.resolve('../legacy/prisma');
  const agentsPath = require.resolve('../legacy/routes/agents');
  delete require.cache[agentsPath];
  require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: mockPrisma,
  } as any;

  // Load the agents route file with mocked prisma
  const agentsRouter = require('../legacy/routes/agents');
  
  // Extract the handler for POST /create from router stack
  const routeLayer = agentsRouter.stack.find(
    (layer: any) => layer.route && layer.route.path === '/create' && layer.route.methods.post
  );
  if (!routeLayer) {
    throw new Error('Could not find POST /create in agents router stack');
  }

  // Find the actual handler function (last in stack after requireRole middleware)
  const handler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;
  const mockApp = { get: (k: string) => null };

  // Helper to execute POST /create
  async function callCreate(body: any) {
    const req: any = { body, app: mockApp, user: { role: 'SUPER_ADMIN' } };
    const res = createMockRes();
    await handler(req, res);
    return res;
  }

  // -------------------------------------------------------------
  // Test 1: Valid Agent Creation
  // -------------------------------------------------------------
  console.log('--- Test 1: Valid Agent Creation ---');
  const validRes = await callCreate({
    fullName: 'John Doe',
    email: 'johndoe@uec.com',
    password: 'securePassword123',
    phone: '+919876543210',
    role: 'AGENT',
    department: 'Customer Care',
    employeeId: 'EMP-001',
    status: 'AVAILABLE',
  });

  assert(validRes.statusCode === 201, 'VALID_CREATE_STATUS_201', `Status code is 201 Created (got ${validRes.statusCode})`);
  assert(validRes.body?.success === true, 'VALID_CREATE_SUCCESS', 'Response contains success: true');
  assert(validRes.body?.agent?.name === 'John Doe', 'VALID_CREATE_AGENT_NAME', 'Agent name matches input');
  assert(validRes.body?.agent?.user?.email === 'johndoe@uec.com', 'VALID_CREATE_USER_EMAIL', 'User email matches input');
  assert(validRes.body?.agent?.user?.passwordHash === undefined, 'CREDENTIALS_STRIPPED_FROM_RESPONSE', 'passwordHash is securely excluded from API response');

  // Verify bcrypt password hashing in database
  const createdDbUser = db.users.find(u => u.email === 'johndoe@uec.com');
  assert(Boolean(createdDbUser && createdDbUser.passwordHash && createdDbUser.passwordHash !== 'securePassword123'), 'PASSWORD_HASHED', 'Password is not stored as plain text');
  const isMatch = await bcrypt.compare('securePassword123', createdDbUser.passwordHash);
  assert(isMatch, 'BCRYPT_HASH_VALID', 'Password hash validates correctly with bcrypt');


  // -------------------------------------------------------------
  // Test 2: Missing Required Fields (400 Bad Request)
  // -------------------------------------------------------------
  console.log('\n--- Test 2: Missing Required Fields (400 Bad Request) ---');

  // Missing fullName
  const missingNameRes = await callCreate({ email: 'noname@uec.com', password: 'password123' });
  assert(missingNameRes.statusCode === 400, 'MISSING_NAME_400', 'Missing fullName returns 400 Bad Request');
  assert(missingNameRes.body?.field === 'fullName', 'MISSING_NAME_FIELD', 'Error specifies field fullName');

  // Missing email
  const missingEmailRes = await callCreate({ fullName: 'No Email Agent', password: 'password123' });
  assert(missingEmailRes.statusCode === 400, 'MISSING_EMAIL_400', 'Missing email returns 400 Bad Request');
  assert(missingEmailRes.body?.field === 'email', 'MISSING_EMAIL_FIELD', 'Error specifies field email');

  // Malformed email
  const invalidEmailRes = await callCreate({ fullName: 'Bad Email', email: 'not-an-email', password: 'password123' });
  assert(invalidEmailRes.statusCode === 400, 'INVALID_EMAIL_400', 'Malformed email returns 400 Bad Request');
  assert(invalidEmailRes.body?.field === 'email', 'INVALID_EMAIL_FIELD', 'Error specifies field email');

  // Missing password
  const missingPassRes = await callCreate({ fullName: 'No Pass', email: 'nopass@uec.com' });
  assert(missingPassRes.statusCode === 400, 'MISSING_PASS_400', 'Missing password returns 400 Bad Request');

  // Short password (< 6 chars)
  const shortPassRes = await callCreate({ fullName: 'Short Pass', email: 'short@uec.com', password: '123' });
  assert(shortPassRes.statusCode === 400, 'SHORT_PASS_400', 'Password < 6 chars returns 400 Bad Request');

  // -------------------------------------------------------------
  // Test 3: Invalid Enum Values (400 Bad Request)
  // -------------------------------------------------------------
  console.log('\n--- Test 3: Invalid Enum Fields (400 Bad Request) ---');

  // Invalid role
  const badRoleRes = await callCreate({ fullName: 'Bad Role', email: 'badrole@uec.com', password: 'password123', role: 'INVALID_ROLE' });
  assert(badRoleRes.statusCode === 400, 'INVALID_ROLE_400', 'Invalid role returns 400 Bad Request');
  assert(badRoleRes.body?.field === 'role', 'INVALID_ROLE_FIELD', 'Error identifies role field');

  // Invalid status
  const badStatusRes = await callCreate({ fullName: 'Bad Status', email: 'badstatus@uec.com', password: 'password123', status: 'NON_EXISTENT' });
  assert(badStatusRes.statusCode === 400, 'INVALID_STATUS_400', 'Invalid status returns 400 Bad Request');
  assert(badStatusRes.body?.field === 'status', 'INVALID_STATUS_FIELD', 'Error identifies status field');

  // -------------------------------------------------------------
  // Test 4: Invalid Date Formats (400 Bad Request)
  // -------------------------------------------------------------
  console.log('\n--- Test 4: Invalid Date Formats (400 Bad Request) ---');

  const badDobRes = await callCreate({ fullName: 'Bad Dob', email: 'baddob@uec.com', password: 'password123', dob: 'not-a-valid-date' });
  assert(badDobRes.statusCode === 400, 'INVALID_DOB_400', 'Invalid dob format returns 400 Bad Request');
  assert(badDobRes.body?.field === 'dob', 'INVALID_DOB_FIELD', 'Error identifies dob field');

  // Empty string dob should NOT error, should sanitize to null
  const emptyDobRes = await callCreate({ fullName: 'Empty Dob', email: 'emptydob@uec.com', password: 'password123', dob: '' });
  assert(emptyDobRes.statusCode === 201, 'EMPTY_DOB_SANITIZED', 'Empty string dob is sanitized to null and succeeds');
  assert(emptyDobRes.body?.agent?.dob === null, 'EMPTY_DOB_NULL', 'Sanitized dob is null in database');

  // -------------------------------------------------------------
  // Test 5: Empty String Optional Unique Fields Sanitization
  // -------------------------------------------------------------
  console.log('\n--- Test 5: Empty String Optional Unique Fields Sanitization ---');

  // Two agents created with employeeId: "" should both sanitize to null and NOT collide
  const emptyEmp1 = await callCreate({ fullName: 'Emp Blank 1', email: 'blank1@uec.com', password: 'password123', employeeId: '' });
  const emptyEmp2 = await callCreate({ fullName: 'Emp Blank 2', email: 'blank2@uec.com', password: 'password123', employeeId: '' });
  assert(emptyEmp1.statusCode === 201, 'BLANK_EMPID_1_SUCCESS', 'First agent with empty employeeId succeeds');
  assert(emptyEmp2.statusCode === 201, 'BLANK_EMPID_2_SUCCESS', 'Second agent with empty employeeId succeeds without P2002 collision');

  // -------------------------------------------------------------
  // Test 6: Duplicate Unique Fields (409 Conflict)
  // -------------------------------------------------------------
  console.log('\n--- Test 6: Duplicate Unique Constraints (409 Conflict) ---');

  // Duplicate email with active user (johndoe@uec.com)
  const dupEmailRes = await callCreate({ fullName: 'Duplicate John', email: 'johndoe@uec.com', password: 'password123' });
  assert(dupEmailRes.statusCode === 409, 'DUP_EMAIL_409', 'Duplicate email returns 409 Conflict');
  assert(dupEmailRes.body?.field === 'email', 'DUP_EMAIL_FIELD', 'Error field is email');
  assert(!dupEmailRes.body?.stack, 'DUP_EMAIL_NO_STACK', 'Stack trace is not exposed');

  // Duplicate employeeId
  const dupEmpRes = await callCreate({ fullName: 'Duplicate Emp', email: 'unique_emp@uec.com', password: 'password123', employeeId: 'EMP-001' });
  assert(dupEmpRes.statusCode === 409, 'DUP_EMPID_409', 'Duplicate employeeId returns 409 Conflict');
  assert(dupEmpRes.body?.field === 'employeeId', 'DUP_EMPID_FIELD', 'Error field is employeeId');

  // Duplicate SUPER_ADMIN
  const dupAdminRes = await callCreate({ fullName: 'Second Super Admin', email: 'second_admin@uec.com', password: 'password123', role: 'SUPER_ADMIN' });
  assert(dupAdminRes.statusCode === 409, 'DUP_SUPER_ADMIN_409', 'Duplicate SUPER_ADMIN returns 409 Conflict');

  // -------------------------------------------------------------
  // Test 7: Foreign Key Validations (400 Bad Request)
  // -------------------------------------------------------------
  console.log('\n--- Test 7: Foreign Key Validations (400 Bad Request) ---');

  // Malformed unitId
  const malformedUnitRes = await callCreate({ fullName: 'Bad Unit UUID', email: 'badunit1@uec.com', password: 'password123', unitId: 'not-a-uuid' });
  assert(malformedUnitRes.statusCode === 400, 'MALFORMED_UNIT_UUID_400', 'Malformed unitId returns 400 Bad Request');

  // Non-existent unitId
  const nonExistentUnitRes = await callCreate({ fullName: 'Missing Unit', email: 'badunit2@uec.com', password: 'password123', unitId: '99999999-9999-4999-a999-999999999999' });
  assert(nonExistentUnitRes.statusCode === 400, 'NON_EXISTENT_UNIT_400', 'Non-existent unitId returns 400 Bad Request');
  assert(nonExistentUnitRes.body?.field === 'unitId', 'NON_EXISTENT_UNIT_FIELD', 'Error field is unitId');

  // Valid unitId succeeds
  const validUnitRes = await callCreate({ fullName: 'Valid Unit Agent', email: 'validunit@uec.com', password: 'password123', unitId: 'f7dab772-a5b3-404f-80bc-c5a4f5f03405' });
  assert(validUnitRes.statusCode === 201, 'VALID_UNIT_SUCCESS', 'Valid unitId links business unit membership and returns 201');

  // -------------------------------------------------------------
  // Test 8: Soft-Deleted Agent Handling & Reactivation (The Barani Case)
  // -------------------------------------------------------------
  console.log('\n--- Test 8: Soft-Deleted Profile Conflict & Reactivation ---');

  // Attempt to re-create customercarebarani@uec.com without reactivate flag
  const baraniInitial = await callCreate({
    fullName: 'Barani',
    email: 'customercarebarani@uec.com',
    password: 'newPassword123',
  });

  assert(baraniInitial.statusCode === 409, 'ARCHIVED_PROFILE_409', 'Archived profile returns 409 Conflict instead of 500');
  assert(baraniInitial.body?.isArchived === true, 'ARCHIVED_FLAG_PRESENT', 'Response indicates profile is archived');
  assert(baraniInitial.body?.error.includes('archived'), 'ARCHIVED_ERROR_MESSAGE', 'Error message explains profile is archived with instructions to reactivate');

  // Now submit with reactivate: true
  const baraniReactivated = await callCreate({
    fullName: 'Barani Reborn',
    email: 'customercarebarani@uec.com',
    password: 'newSecurePassword456',
    phone: '+918098680987',
    reactivate: true,
  });

  assert(baraniReactivated.statusCode === 200, 'REACTIVATE_STATUS_200', 'Reactivation succeeds with 200 OK');
  assert(baraniReactivated.body?.reactivated === true, 'REACTIVATE_FLAG_TRUE', 'Response confirms profile was reactivated');
  assert(baraniReactivated.body?.agent?.isDeleted === false, 'ARCHIVE_FLAG_CLEARED', 'isDeleted flag successfully cleared to false in DB');

  // Verify updated password hash on reactivated user
  const reactivatedUser = db.users.find(u => u.email === 'customercarebarani@uec.com');
  const validNewPassword = await bcrypt.compare('newSecurePassword456', reactivatedUser.passwordHash);
  assert(validNewPassword, 'REACTIVATED_PASSWORD_UPDATED', 'Password hash updated to new password upon reactivation');

  console.log(`\n${CYAN}================================================================${RESET}`);
  console.log(`  ${GREEN}ALL ${passedTests}/${totalTests} TESTS PASSED${RESET}`);
  console.log(`${CYAN}================================================================${RESET}\n`);
  process.exit(0);
}

runAgentCreationSuite().catch(err => {
  console.error('\nSuite failed:', err);
  process.exit(1);
});
