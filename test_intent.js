// =====================================================================
// test_intent.js — Intent Routing Mappings Integration Tests
// =====================================================================
'use strict';

process.env.AI_ENGINE_SERVICE_URL = 'http://localhost:5999';

const assert = require('assert');
const axios = require('axios');

// Mock axios.create before requiring intentController
const originalCreate = axios.create;
let mockAction = null;
axios.create = function() {
  return {
    post: async () => ({ data: mockAction })
  };
};

// Clear require cache for intentController
try {
  delete require.cache[require.resolve('./controllers/intentController')];
} catch (e) {}

const intentController = require('./controllers/intentController');
const db = require('./db');

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

async function runIntentTests() {
  console.log('Running Intent Routing Mappings unit tests...');

  // Mock db.query to resolve successfully for insert operations
  const originalQuery = db.query;
  db.query = async (text, params) => {
    return {
      rowCount: 1,
      rows: [
        {
          id: 'test-uuid-999',
          title: params ? params[2] : 'Mocked Result',
          full_name: params ? params[1] : 'Mocked Lead'
        }
      ]
    };
  };

  const req = {
    tenantId: 'tenant-123',
    authUser: { userId: 'admin-id', role: 'admin' },
    body: {
      text: 'mock command',
      sourceChannel: 'INTERNAL'
    }
  };

  const testActions = [
    { action: 'CREATE_LEAD', data: { fullName: 'Leandro Lead', email: 'lead@sales.com', dealValue: 12000, stage: 'Prospect' } },
    { action: 'CREATE_STORE_ITEM', data: { title: 'Premium Widget', price: 99.99, description: 'Super shiny widget', inventoryCount: 50 } },
    { action: 'CREATE_STORE_PAGE', data: { title: 'About Us', slug: 'about-us', content: 'Our company page' } },
    { action: 'CREATE_WORKSPACE_TASK', data: { title: 'Review Code', description: 'Run test coverage audits', priority: 'HIGH', dueDate: '2026-12-31' } },
    { action: 'CREATE_WORKSPACE_EVENT', data: { title: 'Align Sync Meeting', startsAt: '2026-12-01T10:00:00Z', location: 'Virtual' } },
    { action: 'CREATE_WORKSPACE_DOCUMENT', data: { title: 'Privacy Policy Guide', category: 'Compliance', status: 'FINAL' } }
  ];

  for (const act of testActions) {
    mockAction = act;
    const localRes = mockResponse();
    await intentController.processNaturalLanguageIntent(req, localRes);
    assert(localRes.statusCode === 201 || localRes.statusCode === 200, `Intent execution for action ${act.action} should succeed.`);
    assert.strictEqual(localRes.data.recognizedAction, act.action, `Intent recognized action matches act.action`);
  }

  // Restore
  axios.create = originalCreate;
  db.query = originalQuery;

  console.log('All Intent Routing Mappings unit tests passed successfully!');
}

runIntentTests().catch(err => {
  console.error('Intent test suite failed:', err);
  process.exit(1);
});
