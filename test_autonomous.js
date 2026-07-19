// =====================================================================
// test_autonomous.js — Autonomous Monitor and DevOps Parameter Tests
// =====================================================================
'use strict';

const assert = require('assert');
const db = require('./db');
const axios = require('axios');
const eventDispatcher = require('./services/eventDispatcher');
const { runMonitorTick } = require('./services/autonomousMonitor');

// Mock response capture helper
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

async function runAutonomousTests() {
  console.log('--- STARTING AUTONOMOUS MONITOR & DEVOPS INTEGRATION TESTS ---');

  // Backup original db.query
  const originalQuery = db.query;

  // 1. Assert CREATE_DEVOPS_NODE parameters formatting
  {
    const reqNode = {
      tenantId: 'tenant-999',
      authUser: { userId: 'admin-id', role: 'admin' },
      body: {
        text: 'create devops node', // won't use groq, we mock parsed payload
      }
    };

    let passedBody = null;
    const originalCreateNode = require('./controllers/devopsController').createNode;
    require('./controllers/devopsController').createNode = async (req, res) => {
      passedBody = req.body;
      return res.status(201).json({ id: 'mock-node-1' });
    };

    // Parse Intent payload mock
    const aiResult = {
      action: 'CREATE_DEVOPS_NODE',
      data: {
        name: 'Vultr-Node-1',
        provider: 'VULTR',
        ipAddress: '192.168.1.100',
        branchId: 'branch-uuid-888'
      }
    };

    // Backup and set key
    const originalApiKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'mock_key';

    // Clear require cache to let fresh loader pick up mock GROQ_API_KEY
    try {
      delete require.cache[require.resolve('./controllers/intentController')];
    } catch (e) {}
    const intentController = require('./controllers/intentController');

    const originalPost = axios.post;
    axios.post = async () => ({
      data: {
        choices: [{ message: { content: JSON.stringify(aiResult) } }]
      }
    });

    const res = mockResponse();
    await intentController.processNaturalLanguageIntent(reqNode, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(passedBody.name, 'Vultr-Node-1');
    assert.strictEqual(passedBody.provider, 'VULTR');
    assert.deepStrictEqual(passedBody.config, { ipAddress: '192.168.1.100' }, 'ipAddress must be nested inside config block');
    assert.strictEqual(passedBody.branch_id, 'branch-uuid-888', 'branchId mapped cleanly to branch_id');

    // Restore
    require('./controllers/devopsController').createNode = originalCreateNode;
    axios.post = originalPost;
    process.env.GROQ_API_KEY = originalApiKey;
    console.log('  ✓ CREATE_DEVOPS_NODE formats config ipAddress and branch_id correctly.');
  }

  // 2. Assert CREATE_PIPELINE parameters formatting
  {
    const reqPipe = {
      tenantId: 'tenant-999',
      authUser: { userId: 'admin-id', role: 'admin' },
      body: {
        text: 'create pipeline',
      }
    };

    let passedBody = null;
    const originalCreatePipe = require('./controllers/devopsController').createPipeline;
    require('./controllers/devopsController').createPipeline = async (req, res) => {
      passedBody = req.body;
      return res.status(201).json({ id: 'mock-pipe-1' });
    };

    const aiResult = {
      action: 'CREATE_PIPELINE',
      data: {
        name: 'Deployment-Pipeline',
        nodeId: 'node-uuid-111',
        branchId: 'branch-uuid-888'
      }
    };

    const originalApiKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'mock_key';

    try {
      delete require.cache[require.resolve('./controllers/intentController')];
    } catch (e) {}
    const intentController = require('./controllers/intentController');

    const originalPost = axios.post;
    axios.post = async () => ({
      data: {
        choices: [{ message: { content: JSON.stringify(aiResult) } }]
      }
    });

    const res = mockResponse();
    await intentController.processNaturalLanguageIntent(reqPipe, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(passedBody.name, 'Deployment-Pipeline');
    assert.strictEqual(passedBody.node_id, 'node-uuid-111', 'nodeId maps to node_id');
    assert.strictEqual(passedBody.branch_id, 'branch-uuid-888', 'branchId maps to branch_id');

    // Restore
    require('./controllers/devopsController').createPipeline = originalCreatePipe;
    axios.post = originalPost;
    process.env.GROQ_API_KEY = originalApiKey;
    console.log('  ✓ CREATE_PIPELINE formats parameters (node_id, branch_id) correctly.');
  }

  // 3. Verify Background Autonomous Loop operations (Read-Only & Alerts)
  {
    // Mock db.query to return a mock active tenant list
    db.query = async (sql, params) => {
      if (sql.includes('SELECT id, name FROM tenants')) {
        return {
          rowCount: 1,
          rows: [{ id: 'tenant-auto-777', name: 'Auto Tenant' }]
        };
      }
      return { rowCount: 0, rows: [] };
    };

    // Mock eventDispatcher to catch alerts
    let alertDispatched = null;
    const originalDispatch = eventDispatcher.dispatchAsync;
    eventDispatcher.dispatchAsync = async (eventName, tenantId, payload) => {
      if (eventName === 'autonomous.alert') {
        alertDispatched = { tenantId, payload };
      }
    };

    // Mock controllers
    const originalFinance = require('./controllers/financeController').getFinanceSummary;
    const originalListFees = require('./controllers/feesController').listFees;
    const originalListNodes = require('./controllers/devopsController').listNodes;

    // Simulate NEGATIVE_CASHFLOW trigger
    require('./controllers/financeController').getFinanceSummary = async (req, res) => {
      return res.status(200).json({ netCashflow: -1250 }); // Negative net cashflow
    };
    require('./controllers/feesController').listFees = async (req, res) => {
      return res.status(200).json([]);
    };
    require('./controllers/devopsController').listNodes = async (req, res) => {
      return res.status(200).json([]);
    };

    // Execute Operational Tick
    await runMonitorTick();

    assert(alertDispatched, 'Should dispatch alert when negative net cashflow is encountered');
    assert.strictEqual(alertDispatched.tenantId, 'tenant-auto-777');
    assert.strictEqual(alertDispatched.payload.type, 'NEGATIVE_CASHFLOW');
    assert(alertDispatched.payload.detail.includes('PGK -1250'));
    console.log('  ✓ Autonomous loop detects net negative cashflow and dispatches autonomous.alert event.');

    // Reset alert and simulate OFFLINE_NODE trigger
    alertDispatched = null;
    require('./controllers/financeController').getFinanceSummary = async (req, res) => {
      return res.status(200).json({ netCashflow: 5000 }); // Positive
    };
    require('./controllers/devopsController').listNodes = async (req, res) => {
      return res.status(200).json([{ id: 'node-offline-uuid', name: 'Worker Node 5' }]);
    };

    const originalSyncNode = require('./controllers/devopsController').syncNode;
    require('./controllers/devopsController').syncNode = async (req, res) => {
      // Simulate sync returning failed node state
      return res.status(200).json({ id: 'node-offline-uuid', status: 'failed' });
    };

    await runMonitorTick();

    assert(alertDispatched, 'Should dispatch alert when offline worker node is encountered');
    assert.strictEqual(alertDispatched.payload.type, 'OFFLINE_NODE');
    assert(alertDispatched.payload.detail.includes('Worker Node 5'));
    console.log('  ✓ Autonomous loop detects failed/offline nodes and dispatches autonomous.alert event.');

    // Restore original controllers and db.query
    require('./controllers/financeController').getFinanceSummary = originalFinance;
    require('./controllers/feesController').listFees = originalListFees;
    require('./controllers/devopsController').listNodes = originalListNodes;
    require('./controllers/devopsController').syncNode = originalSyncNode;
    eventDispatcher.dispatchAsync = originalDispatch;
    db.query = originalQuery;
  }

  console.log('--- ALL AUTONOMOUS MONITOR & DEVOPS INTEGRATION TESTS PASSED ---');
}

runAutonomousTests().catch(err => {
  console.error('Autonomous test suite failed:', err);
  process.exit(1);
});
