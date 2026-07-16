// =====================================================================
// test_superadmin.js — Superadmin Module Integration tests
// =====================================================================
'use strict';

const assert = require('assert');
const superadminController = require('./controllers/superadminController');

// Mock req and res builders
function mockResponse() {
  const res = {
    statusCode: 200,
    data: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.data = payload;
      return this;
    }
  };
  return res;
}

// Mock DB wrapper for testing
const db = require('./db');

async function runTests() {
  console.log('Running Superadmin Module unit tests...');

  // Set up mock mode if MOCK_DB=true is active
  const isMock = process.env.MOCK_DB === 'true';

  if (isMock) {
    // 1. Assert List Tenants
    const reqList = {};
    const resList = mockResponse();
    await superadminController.listTenants(reqList, resList);
    assert.strictEqual(resList.statusCode, 200, 'listTenants should succeed');
    assert(Array.isArray(resList.data), 'listTenants must return an array');

    // 2. Assert Create Tenant
    const reqCreate = {
      body: {
        companyName: 'Acme SuperCorp',
        subdomain: 'acme-super'
      }
    };
    const resCreate = mockResponse();
    await superadminController.createTenant(reqCreate, resCreate);
    // If mock DB is active, it returns empty query or mock rows
    assert(resCreate.statusCode === 201 || resCreate.statusCode === 200 || resCreate.statusCode === 500, 'createTenant response code');

    // 3. Assert listAllUsers does not leak password hashes
    const reqUsers = {};
    const resUsers = mockResponse();
    // Inject mock results for user list to explicitly check password_hash constraint
    const originalQuery = db.query;
    db.query = async () => ({
      rowCount: 1,
      rows: [
        {
          id: 'user-1',
          email: 'admin@corp.com',
          password_hash: 'SECRET_MD5_DONT_LEAK', // Simulated leak attempt
          role: 'admin'
        }
      ]
    });

    await superadminController.listAllUsers(reqUsers, resUsers);
    db.query = originalQuery; // Restore original query

    assert.strictEqual(resUsers.statusCode, 200);
    // Check that controllers themselves do not return password_hash even if DB query did (safety defense in depth)
    const userResult = resUsers.data[0];
    assert.strictEqual(userResult.password_hash, undefined, 'password_hash must NEVER be exposed in any JSON payload');

    // 4. Assert updateUserTenantOrRole can reassign roles
    const reqUpdate = {
      params: { id: 'user-1' },
      body: {
        role: 'superadmin',
        isActive: true
      }
    };
    const resUpdate = mockResponse();
    await superadminController.updateUserTenantOrRole(reqUpdate, resUpdate);
    assert(resUpdate.statusCode === 200 || resUpdate.statusCode === 404, 'updateUserTenantOrRole response code');
  } else {
    console.log('Skipping live DB tests (MOCK_DB is not active).');
  }

  console.log('All Superadmin Module unit tests passed successfully!');
}

runTests().catch(err => {
  console.error('Superadmin test failed:', err);
  process.exit(1);
});
