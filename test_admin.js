// =====================================================================
// test_admin.js
// Unit tests for admin user management operations, role-hardening,
// branch CRUD, tenant config, and Last Admin Guard behavior.
// =====================================================================
'use strict';

const assert = require('assert');

// Mock state we can change in tests
const testState = {
  activeAdminCount: 1,
  targetUserRole: 'admin',
  targetUserIsActive: true,
  branchExists: true,
  branchBelongsToTenant: true,
};

// Mock db.js dependency
const mockDb = {
  queries: [],
  query: async function(text, params) {
    this.queries.push({ text, params });

    // 1. Fetching active user for Last Admin Guard
    if (text.startsWith('SELECT role, is_active FROM users WHERE id = $1 AND tenant_id = $2')) {
      return {
        rowCount: 1,
        rows: [{ role: testState.targetUserRole, is_active: testState.targetUserIsActive }]
      };
    }

    // 2. Counting active admins for Last Admin Guard
    if (text.startsWith("SELECT count(*) FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true")) {
      return {
        rowCount: 1,
        rows: [{ count: testState.activeAdminCount.toString() }]
      };
    }

    // 3. Email uniqueness check
    if (text.startsWith('SELECT id FROM users WHERE tenant_id = $1 AND email = $2')) {
      if (params[1] === 'duplicate@tenant.com') {
        return { rowCount: 1, rows: [{ id: 'existing' }] };
      }
      return { rowCount: 0, rows: [] };
    }

    // 4. Listing Users
    if (text.startsWith('SELECT id, full_name, email, role, is_active, branch_id, created_at')) {
      return { rows: [{ id: 'user-1', full_name: 'John Admin', email: 'john@tenant.com', role: 'admin', is_active: true }] };
    }

    // 5. Inserting Users
    if (text.startsWith('INSERT INTO users')) {
      return { rows: [{ id: 'user-new', tenant_id: params[0], full_name: params[2], email: params[3], role: params[5], is_active: true }] };
    }

    // 6. Updating Users
    if (text.startsWith('UPDATE users')) {
      return { rowCount: 1, rows: [{ id: params[params.length - 2], role: params[2], is_active: true }] };
    }

    // 7. Deleting Users
    if (text.startsWith('DELETE FROM users')) {
      return { rowCount: 1, rows: [{ id: params[0] }] };
    }

    // 8. Checking branch ownership
    if (text.startsWith('SELECT id FROM branches WHERE id = $1 AND tenant_id = $2')) {
      if (testState.branchBelongsToTenant) {
        return { rowCount: 1, rows: [{ id: params[0] }] };
      }
      return { rowCount: 0, rows: [] };
    }

    // 9. Listing Branches
    if (text.includes('SELECT id, tenant_id, branch_name, location_city, is_hub, created_at') && text.includes('branches')) {
      return { rowCount: 1, rows: [{ id: 'branch-1', branch_name: 'HQ' }] };
    }

    // 10. Creating Branch
    if (text.startsWith('INSERT INTO branches')) {
      return { rowCount: 1, rows: [{ id: 'branch-new', branch_name: params[1] }] };
    }

    // 11. Updating Branch
    if (text.startsWith('UPDATE branches')) {
      return { rowCount: 1, rows: [{ id: params[3], branch_name: params[0] }] };
    }

    // 12. Deleting Branch
    if (text.startsWith('DELETE FROM branches')) {
      return { rowCount: 1, rows: [{ id: params[0] }] };
    }

    // 13. Tenant config - GET
    if (text.includes('SELECT id, company_name, subdomain, is_active') && text.includes('tenants')) {
      return { rowCount: 1, rows: [{ id: 'tenant-123', company_name: 'Acme', subdomain: 'acme', is_active: true }] };
    }

    // 14. Tenant config - UPDATE
    if (text.startsWith('UPDATE tenants')) {
      return { rowCount: 1, rows: [{ id: 'tenant-123', company_name: params[0], subdomain: 'acme', is_active: true }] };
    }

    return { rows: [], rowCount: 0 };
  },
  getClient: async function() {
    return {
      query: async (text, params) => {
        mockDb.queries.push({ text, params });
        if (text.startsWith('INSERT INTO users')) {
          return { rows: [{ id: 'user-new', tenant_id: params[0], full_name: params[1], email: params[2], role: params[4] }] };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {}
    };
  },
  reset: function() {
    this.queries = [];
    testState.activeAdminCount = 1;
    testState.targetUserRole = 'admin';
    testState.targetUserIsActive = true;
    testState.branchExists = true;
    testState.branchBelongsToTenant = true;
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

  // 8. Admin - updateUser Guard Self-Demotion
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.params = { id: 'user-1' }; // Current user's ID
    req.body = { role: 'employee' };
    await adminController.updateUser(req, res);
    assert.strictEqual(res.statusCode, 400, 'Self-demotion must be blocked with 400');
    assert.ok(res.jsonData.error.includes('Self-demotion is not allowed'));
  }

  // 9. Admin - updateUser Guard Self-Suspension
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.params = { id: 'user-1' }; // Current user's ID
    req.body = { is_active: false };
    await adminController.updateUser(req, res);
    assert.strictEqual(res.statusCode, 400, 'Self-suspension must be blocked with 400');
    assert.ok(res.jsonData.error.includes('Self-suspension is not allowed'));
  }

  // 10. Admin - updateUser Success
  {
    mockDb.reset();
    testState.activeAdminCount = 2; // Satisfies Last Admin Guard
    const { req, res } = mockReqRes();
    req.params = { id: 'user-some-other' };
    req.body = { full_name: 'Updated Name', role: 'manager' };
    await adminController.updateUser(req, res);
    assert.strictEqual(res.statusCode, 200);
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
    assert.strictEqual(insertQuery.params[4], 'employee', 'Public signup must force role as employee');
  }

  // 13. Last Admin Guard - Block Demotion of Last Admin
  {
    mockDb.reset();
    testState.activeAdminCount = 1; // Only 1 active admin exists!
    const { req, res } = mockReqRes();
    req.params = { id: 'user-some-other' }; // Targeted admin
    req.body = { role: 'employee' }; // Proposed demotion
    await adminController.updateUser(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.jsonData.error, 'Cannot remove or demote the last active admin.');
  }

  // 14. Last Admin Guard - Block Suspension of Last Admin
  {
    mockDb.reset();
    testState.activeAdminCount = 1; // Only 1 active admin exists!
    const { req, res } = mockReqRes();
    req.params = { id: 'user-some-other' }; // Targeted admin
    req.body = { is_active: false }; // Proposed suspension
    await adminController.updateUser(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.jsonData.error, 'Cannot remove or demote the last active admin.');
  }

  // 15. Last Admin Guard - Block Deletion of Last Admin
  {
    mockDb.reset();
    testState.activeAdminCount = 1; // Only 1 active admin exists!
    const { req, res } = mockReqRes();
    req.params = { id: 'user-some-other' }; // Targeted admin
    await adminController.deleteUser(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.jsonData.error, 'Cannot remove or demote the last active admin.');
  }

  // 16. Last Admin Guard - Block Self-Deletion
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.params = { id: 'user-1' }; // Self user-1
    await adminController.deleteUser(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.jsonData.error, 'Self-deletion is not allowed.');
  }

  // 17. Branch CRUD - listBranches
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    await adminController.listBranches(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonData[0].branch_name, 'HQ');
  }

  // 18. Branch CRUD - createBranch
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { branch_name: 'Lae Logistics Hub', location_city: 'Lae', is_hub: true };
    await adminController.createBranch(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.jsonData.branch_name, 'Lae Logistics Hub');
  }

  // 19. Branch CRUD - updateBranch
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.params = { id: 'branch-1' };
    req.body = { branch_name: 'HQ Updated', location_city: 'POM', is_hub: false };
    await adminController.updateBranch(req, res);
    assert.strictEqual(res.statusCode, 200);
  }

  // 20. Branch CRUD - deleteBranch
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.params = { id: 'branch-1' };
    await adminController.deleteBranch(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonData.message, 'Branch deleted successfully.');
  }

  // 21. Tenant Settings - getTenant
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    await adminController.getTenant(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonData.company_name, 'Acme');
  }

  // 22. Tenant Settings - updateTenant (Safe Update)
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { company_name: 'Acme New' };
    await adminController.updateTenant(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonData.company_name, 'Acme New');
  }

  // 23. Tenant Settings - updateTenant (Block Subdomain Edits)
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { company_name: 'Acme New', subdomain: 'new-subdomain' };
    await adminController.updateTenant(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.jsonData.error, 'Subdomain parameter cannot be modified.');
  }

  console.log('All Admin Module and Role Hardening unit tests passed successfully!');
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
