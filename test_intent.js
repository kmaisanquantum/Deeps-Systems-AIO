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
  const queriesExecuted = [];
  db.query = async (text, params) => {
    queriesExecuted.push({ text: text.trim().replace(/\s+/g, ' '), params });
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

  // Test Stage A: Standard AI engine execution paths (mocked external endpoint)
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

  // Test Stage B: Rule-based local fallback parser unit assertions
  console.log('Running local regex parser unit assertions...');

  // Clean require context and reset AI_ENGINE_SERVICE_URL to empty to force local parsing
  const originalAiUrl = process.env.AI_ENGINE_SERVICE_URL;
  process.env.AI_ENGINE_SERVICE_URL = '';

  try {
    delete require.cache[require.resolve('./controllers/intentController')];
  } catch (e) {}
  const localIntentController = require('./controllers/intentController');

  const localReq = {
    tenantId: 'tenant-123',
    authUser: { userId: 'admin-id', role: 'admin' },
    body: {
      text: '',
      sourceChannel: 'INTERNAL'
    }
  };

  // 1. Expense parsing
  {
    localReq.body.text = 'log expense 250 USD office supplies';
    const res = mockResponse();
    queriesExecuted.length = 0;
    await localIntentController.processNaturalLanguageIntent(localReq, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.recognizedAction, 'CREATE_EXPENSE');
    assert.strictEqual(res.data.data.amount, 250);
    assert.strictEqual(res.data.data.currency, 'USD');
    assert.strictEqual(res.data.data.notes, 'office supplies');
    console.log('✓ Local parsing of CREATE_EXPENSE verified.');
  }

  // 2. Income parsing
  {
    localReq.body.text = 'received 1500 PGK tuition';
    const res = mockResponse();
    queriesExecuted.length = 0;
    await localIntentController.processNaturalLanguageIntent(localReq, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.recognizedAction, 'CREATE_INCOME');
    assert.strictEqual(res.data.data.amount, 1500);
    assert.strictEqual(res.data.data.currency, 'PGK');
    assert.strictEqual(res.data.data.notes, 'tuition');
    console.log('✓ Local parsing of CREATE_INCOME verified.');
  }

  // 3. Sales Lead parsing
  {
    localReq.body.text = 'create lead John Galt email john@galt.com value 50000';
    const res = mockResponse();
    queriesExecuted.length = 0;
    await localIntentController.processNaturalLanguageIntent(localReq, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.recognizedAction, 'CREATE_LEAD');
    assert.strictEqual(res.data.data.fullName, 'John Galt');
    assert.strictEqual(res.data.data.email, 'john@galt.com');
    assert.strictEqual(res.data.data.dealValue, 50000);
    console.log('✓ Local parsing of CREATE_LEAD verified.');
  }

  // 4. Workspace Task parsing
  {
    localReq.body.text = 'add task Call supplier';
    const res = mockResponse();
    queriesExecuted.length = 0;
    await localIntentController.processNaturalLanguageIntent(localReq, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.recognizedAction, 'CREATE_WORKSPACE_TASK');
    assert.strictEqual(res.data.data.title, 'Call supplier');
    console.log('✓ Local parsing of CREATE_WORKSPACE_TASK verified.');
  }

  // 5. Store Item parsing
  {
    localReq.body.text = 'create item Premium Widget price 99.99';
    const res = mockResponse();
    queriesExecuted.length = 0;
    await localIntentController.processNaturalLanguageIntent(localReq, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.recognizedAction, 'CREATE_STORE_ITEM');
    assert.strictEqual(res.data.data.title, 'Premium Widget');
    assert.strictEqual(res.data.data.price, 99.99);
    console.log('✓ Local parsing of CREATE_STORE_ITEM verified.');
  }

  // 6. Logistics Shipment parsing
  {
    localReq.body.text = 'create shipment to Port Moresby';
    const res = mockResponse();
    queriesExecuted.length = 0;
    await localIntentController.processNaturalLanguageIntent(localReq, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.recognizedAction, 'CREATE_SHIPMENT');
    assert.strictEqual(res.data.data.destinationAddress, 'Port Moresby');
    console.log('✓ Local parsing of CREATE_SHIPMENT verified.');
  }

  // 7. Non-matching command (should yield HTTP 422 with examples)
  {
    localReq.body.text = 'unrecognized random command';
    const res = mockResponse();
    queriesExecuted.length = 0;
    await localIntentController.processNaturalLanguageIntent(localReq, res);
    assert.strictEqual(res.statusCode, 422);
    assert(res.data.error.includes("Try: 'log expense 250'"), 'Non-matching local command should return error instructions.');
    console.log('✓ Non-matching commands trigger helpful 422 examples block.');
  }

  // Test Stage C: Conversational AI Agent Integration via Groq & Llama 3.3
  console.log('Running Conversational Groq & Llama 3.3 unit & integration assertions...');
  const originalGroqApiKey = process.env.GROQ_API_KEY;
  const originalGroqModel = process.env.GROQ_MODEL;
  const originalGroqBaseUrl = process.env.GROQ_BASE_URL;

  process.env.GROQ_API_KEY = 'gsk_mock_api_key_1234567890';
  process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
  process.env.GROQ_BASE_URL = 'https://api.groq.com/openai/v1/'; // with trailing slash to verify sanitization

  // Reload intentController to pick up new env vars
  try {
    delete require.cache[require.resolve('./controllers/intentController')];
  } catch (e) {}
  const groqIntentController = require('./controllers/intentController');

  // Mock axios.post globally for Groq completions
  const originalAxiosPost = axios.post;
  let groqMockResponse = null;
  let lastPostUrl = null;
  let lastPostData = null;

  axios.post = async (url, data, config) => {
    lastPostUrl = url;
    lastPostData = data;
    if (groqMockResponse === 'FORCE_FAILURE') {
      throw new Error('Groq network timeout or rate limit exceeded');
    }
    return { data: groqMockResponse };
  };

  // 1. Verify successful Groq call and JSON parsing
  {
    groqMockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              action: 'CREATE_EXPENSE',
              data: { amount: 375, currency: 'USD', notes: 'Server domain reservation' }
            })
          }
        }
      ]
    };

    const reqGroq = {
      tenantId: 'tenant-123',
      authUser: { userId: 'admin-id', role: 'admin' },
      body: {
        text: 'buy domain on USD 375',
        sourceChannel: 'INTERNAL'
      }
    };

    const res = mockResponse();
    queriesExecuted.length = 0;
    await groqIntentController.processNaturalLanguageIntent(reqGroq, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.recognizedAction, 'CREATE_EXPENSE');
    assert.strictEqual(res.data.data.amount, 375);
    assert.strictEqual(res.data.data.currency, 'USD');
    assert.strictEqual(res.data.data.notes, 'Server domain reservation');
    assert.strictEqual(lastPostUrl, 'https://api.groq.com/openai/v1/chat/completions', 'URL trailing slashes must be cleanly sanitized');
    assert.strictEqual(lastPostData.model, 'llama-3.3-70b-versatile', 'Model must match configured model');
    console.log('✓ Groq & Llama 3.3 integration parsed and executed correctly.');
  }

  // 2. Verify fallback to rule-based parser when Groq returns non-JSON/invalid payload
  {
    groqMockResponse = {
      choices: [
        {
          message: {
            content: "I cannot parse this, but here's some text: invalid-json"
          }
        }
      ]
    };

    const reqGroq = {
      tenantId: 'tenant-123',
      authUser: { userId: 'admin-id', role: 'admin' },
      body: {
        text: 'log expense 120 PGK printer paper',
        sourceChannel: 'INTERNAL'
      }
    };

    const res = mockResponse();
    queriesExecuted.length = 0;
    await groqIntentController.processNaturalLanguageIntent(reqGroq, res);

    assert.strictEqual(res.statusCode, 201, 'Should fall back gracefully and execute the fallback intent');
    assert.strictEqual(res.data.recognizedAction, 'CREATE_EXPENSE');
    assert.strictEqual(res.data.data.amount, 120);
    assert.strictEqual(res.data.data.notes, 'printer paper');
    console.log('✓ Fallback to local regex works when Groq returns non-JSON/invalid payload.');
  }

  // 3. Verify fallback to local regex parser when Groq API call fails completely (timeout/error)
  {
    groqMockResponse = 'FORCE_FAILURE';

    const reqGroq = {
      tenantId: 'tenant-123',
      authUser: { userId: 'admin-id', role: 'admin' },
      body: {
        text: 'received 450 PGK from sale',
        sourceChannel: 'INTERNAL'
      }
    };

    const res = mockResponse();
    queriesExecuted.length = 0;
    await groqIntentController.processNaturalLanguageIntent(reqGroq, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.recognizedAction, 'CREATE_INCOME');
    assert.strictEqual(res.data.data.amount, 450);
    assert.strictEqual(res.data.data.notes, 'from sale');
    console.log('✓ Fallback to local regex works when Groq endpoint fails completely (timeout/network error).');
  }

  // Restore state
  process.env.AI_ENGINE_SERVICE_URL = originalAiUrl;
  process.env.GROQ_API_KEY = originalGroqApiKey;
  process.env.GROQ_MODEL = originalGroqModel;
  process.env.GROQ_BASE_URL = originalGroqBaseUrl;
  axios.post = originalAxiosPost;
  axios.create = originalCreate;
  db.query = originalQuery;

  console.log('All Intent Routing Mappings unit tests passed successfully!');
}

runIntentTests().catch(err => {
  console.error('Intent test suite failed:', err);
  process.exit(1);
});
