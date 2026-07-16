// =====================================================================
// test_admin.js
// Unit tests for admin user management operations and role-hardening
// =====================================================================
'use strict';

const assert = require('assert');

// Mock db.js dependency
const mockDb = {
  queries: [],
  query: async function(text, params) {
    this.queries.push({ text, params });
    if (text.startsWith('SELECT id, full_name, email, role, is_active')) {
      return { rows: [{ id: 'user-1', full_name: 'John Admin', email: 'john@tenant.com', role: 'admin', is_active: true }] };
    }
    if (text.startsWith('SELECT id FROM users WHERE tenant_id = $1 AND email = $2')) {
      if (params[1] === 'duplicate@tenant.com') {
        return { rowCount: 1, rows: [{ id: 'existing' }] };
      }
      return { rowCount: 0, rows: [] };
    }
    if (text.startsWith('INSERT INTO users')) {
      return { rows: [{ id: 'user-new', tenant_id: params[0], full_name: params[2], email: params[3], role: params[5], is_active: true }] };
    }
    if (text.startsWith('UPDATE users')) {
      if (params[1] === 'nonexistent') {
        return { rowCount: 0, rows: [] };
      }
      // UPDATE users SET role = $1 ... WHERE id = $2 AND tenant_id = $3
      return { rowCount: 1, rows: [{ id: params[1], role: params[0], tenant_id: params[2], is_active: params[0] === true || params[0] === false ? params[0] : true }] };
    }
    return { rows: [], rowCount: 0 };
  },
  getClient: async function() {
    return {
      query: async (text, params) => {
        mockDb.queries.push({ text, params });
        if (text.startsWith('INSERT INTO users')) {
          // params[4] is role
          return { rows: [{ id: 'user-new', tenant_id: params[0], full_name: params[1], email: params[2], role: params[4] }] };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {}
    };
  },
  reset: function() {
    this.queries = [];
  }
};

// Override the module cache for '../db' to inject our mockDb
require.cache[require.resolve('./db')] = {
  id: require.resolve('./db'),
  filename: require.resolve('./db'),
  loaded: true,
  exports: mockDb
};

const adminController = require('./controllers/adminController');
const authController = require('./controllers/authController');
const { requireAuth, requireRole } = require('./middleware/tenantResolver');

// Helper to construct mock Express request and response
function mockReqRes(reqData = {}) {
  const req = {
    tenantId: 'tenant-123',
    authUser: {
      userId: 'user-1',
      role: 'admin',
      tenantId: 'tenant-123'
    },
    params: {},
    body: {},
    ...reqData
  };

  const res = {
    statusCode: null,
    jsonData: null,
    status: function(code) {
      this.statusCode = code;
      return this;
    },
    json: function(data) {
      this.jsonData = data;
      return this;
    }
  };

  return { req, res };
}

async function runTests() {
  console.log('Running Admin Module and Role Hardening unit tests...');

  // 1. Auth Guard - requireAuth Success
  {
    const { req, res } = mockReqRes();
    let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, 'requireAuth should call next() when authUser is present');
  }

  // 2. Auth Guard - requireAuth Failure
  {
    const { req, res } = mockReqRes({ authUser: null });
    let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, 'requireAuth should NOT call next() when authUser is missing');
    assert.strictEqual(res.statusCode, 401, 'requireAuth should return 401');
  }

  // 3. Role Guard - requireRole Success
  {
    const { req, res } = mockReqRes();
    let nextCalled = false;
    const guard = requireRole('admin', 'manager');
    guard(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, 'requireRole should succeed with matched role');
  }

  // 4. Role Guard - requireRole Failure
  {
    const { req, res } = mockReqRes();
    req.authUser.role = 'employee';
    let nextCalled = false;
    const guard = requireRole('admin');
    guard(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, 'requireRole should fail for unauthorized role');
    assert.strictEqual(res.statusCode, 403, 'requireRole should return 403');
  }

  // 5. Admin - listUsers
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    await adminController.listUsers(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonData[0].full_name, 'John Admin');
    assert.strictEqual(mockDb.queries[0].params[0], 'tenant-123', 'Query must scope by tenant_id');
  }

  // 6. Admin - createUser Success
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { fullName: 'New Staff', email: 'staff@tenant.com', password: 'secretpassword', role: 'manager' };
    await adminController.createUser(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.jsonData.role, 'manager');
  }

  // 7. Admin - createUser Unique Constraint Violation
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { fullName: 'Dup User', email: 'duplicate@tenant.com', password: 'password', role: 'employee' };
    await adminController.createUser(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.jsonData.error.includes('already exists'), 'Should return custom exists error message');
  }

  // 8. Admin - updateUserRole Guard Self-Demotion
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.params = { id: 'user-1' }; // Current user's ID
    req.body = { role: 'employee' };
    await adminController.updateUserRole(req, res);
    assert.strictEqual(res.statusCode, 400, 'Self-demotion must be blocked with 400');
    assert.ok(res.jsonData.error.includes('Self-demotion is not allowed'));
  }

  // 9. Admin - updateUserStatus Guard Self-Suspension
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.params = { id: 'user-1' }; // Current user's ID
    req.body = { isActive: false };
    await adminController.updateUserStatus(req, res);
    assert.strictEqual(res.statusCode, 400, 'Self-suspension must be blocked with 400');
    assert.ok(res.jsonData.error.includes('Self-suspension is not allowed'));
  }

  // 10. Admin - updateUserRole Success
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.params = { id: 'user-some-other' };
    req.body = { role: 'manager' };
    await adminController.updateUserRole(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonData.role, 'manager');
  }

  // 11. Admin - resetUserPassword Success
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.params = { id: 'user-some-other' };
    req.body = { password: 'newpassword123' };
    await adminController.resetUserPassword(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonData.message, 'Password reset successfully.');
  }

  // 12. Register Role-Hardening - Forced 'employee' role
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { fullName: 'Hacker Admin', email: 'hacker@tenant.com', password: 'hackpassword', role: 'admin' };
    await authController.register(req, res);
    assert.strictEqual(res.statusCode, 201, 'Registration should succeed');
    const insertQuery = mockDb.queries.find(q => q.text.startsWith('INSERT INTO users'));
    assert.ok(insertQuery, 'User INSERT query should be executed');
    // params layout for user insert: [tenantId, fullName, email, passwordHash, role]
    assert.strictEqual(insertQuery.params[4], 'employee', 'Public signup must force role as employee');
  }

  console.log('All Admin Module and Role Hardening unit tests passed successfully!');
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
