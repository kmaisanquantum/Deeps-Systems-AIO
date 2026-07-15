// =====================================================================
// test_workspace.js
// Unit tests for controllers/workspaceController.js
// =====================================================================
'use strict';

const assert = require('assert');

// Mock db.js dependency before requiring the controller
const mockDb = {
  queries: [],
  query: async function(text, params) {
    this.queries.push({ text, params });
    if (text.startsWith('SELECT * FROM workspace_tasks')) {
      return { rows: [{ id: 'task-1', title: 'Task 1', tenant_id: params[0] }] };
    }
    if (text.startsWith('INSERT INTO workspace_tasks')) {
      return { rows: [{ id: 'task-2', title: params[2], tenant_id: params[0], status: params[5], priority: params[6] }] };
    }
    if (text.startsWith('UPDATE workspace_tasks')) {
      if (params[1] === 'nonexistent') {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [{ id: params[1], status: params[0], tenant_id: params[2] }] };
    }
    if (text.startsWith('SELECT * FROM workspace_events')) {
      return { rows: [{ id: 'event-1', title: 'Event 1', tenant_id: params[0] }] };
    }
    if (text.startsWith('INSERT INTO workspace_events')) {
      return { rows: [{ id: 'event-2', title: params[2], tenant_id: params[0] }] };
    }
    if (text.startsWith('SELECT * FROM workspace_documents')) {
      return { rows: [{ id: 'doc-1', title: 'Doc 1', tenant_id: params[0] }] };
    }
    if (text.startsWith('INSERT INTO workspace_documents')) {
      return { rows: [{ id: 'doc-2', title: params[2], tenant_id: params[0], status: params[6] }] };
    }
    return { rows: [], rowCount: 0 };
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

const workspaceController = require('./controllers/workspaceController');

// Helper to construct mock Express request and response
function mockReqRes(reqData = {}) {
  const req = {
    tenantId: 'tenant-123',
    branchId: 'branch-456',
    params: {},
    body: {},
    query: {},
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
  console.log('Running Workspace Controller unit tests...');

  // 1. listTasks
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    await workspaceController.listTasks(req, res);
    assert.strictEqual(res.statusCode, 200, 'listTasks should return 200');
    assert.strictEqual(res.jsonData[0].id, 'task-1', 'listTasks should return mock tasks');
    assert.strictEqual(mockDb.queries[0].params[0], 'tenant-123', 'listTasks query should be tenant-scoped');
  }

  // 2. listTasks - Missing Tenant ID
  {
    mockDb.reset();
    const { req, res } = mockReqRes({ tenantId: null });
    await workspaceController.listTasks(req, res);
    assert.strictEqual(res.statusCode, 400, 'listTasks should fail with 400 if tenant is missing');
  }

  // 3. createTask
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { title: 'New Task', description: 'Some description', priority: 'HIGH', dueDate: '2026-12-31' };
    await workspaceController.createTask(req, res);
    assert.strictEqual(res.statusCode, 201, 'createTask should return 201');
    assert.strictEqual(res.jsonData.title, 'New Task', 'createTask should return created task');
    assert.strictEqual(res.jsonData.status, 'TODO', 'createTask should default status to TODO');
    assert.strictEqual(res.jsonData.priority, 'HIGH', 'createTask should accept custom priority');
  }

  // 4. createTask - Missing Title
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { description: 'Missing Title' };
    await workspaceController.createTask(req, res);
    assert.strictEqual(res.statusCode, 400, 'createTask should fail with 400 if title is missing');
  }

  // 5. createTask - Invalid Status
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { title: 'Invalid Status Task', status: 'COMPLETED' };
    await workspaceController.createTask(req, res);
    assert.strictEqual(res.statusCode, 400, 'createTask should fail with 400 for invalid status');
  }

  // 6. updateTaskStatus
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.params = { id: 'task-123' };
    req.body = { status: 'IN_PROGRESS' };
    await workspaceController.updateTaskStatus(req, res);
    assert.strictEqual(res.statusCode, 200, 'updateTaskStatus should return 200');
    assert.strictEqual(res.jsonData.status, 'IN_PROGRESS', 'updateTaskStatus should return updated status');
    assert.strictEqual(mockDb.queries[0].params[1], 'task-123', 'updateTaskStatus should target correct task ID');
    assert.strictEqual(mockDb.queries[0].params[2], 'tenant-123', 'updateTaskStatus should target correct tenant ID');
  }

  // 7. updateTaskStatus - Task Not Found
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.params = { id: 'nonexistent' };
    req.body = { status: 'DONE' };
    await workspaceController.updateTaskStatus(req, res);
    assert.strictEqual(res.statusCode, 404, 'updateTaskStatus should return 404 if task is not found');
  }

  // 8. listEvents
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    await workspaceController.listEvents(req, res);
    assert.strictEqual(res.statusCode, 200, 'listEvents should return 200');
    assert.strictEqual(res.jsonData[0].id, 'event-1');
  }

  // 9. createEvent
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { title: 'New Sync Meet', startsAt: '2026-08-01T10:00:00Z', location: 'Zoom Link' };
    await workspaceController.createEvent(req, res);
    assert.strictEqual(res.statusCode, 201, 'createEvent should return 201');
    assert.strictEqual(res.jsonData.title, 'New Sync Meet');
  }

  // 10. createEvent - Missing startsAt
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { title: 'No Start' };
    await workspaceController.createEvent(req, res);
    assert.strictEqual(res.statusCode, 400, 'createEvent should fail with 400 if startsAt is missing');
  }

  // 11. listDocuments
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    await workspaceController.listDocuments(req, res);
    assert.strictEqual(res.statusCode, 200, 'listDocuments should return 200');
    assert.strictEqual(res.jsonData[0].id, 'doc-1');
  }

  // 12. createDocument
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { title: 'Standard SOP', category: 'Tech', status: 'FINAL', content: 'Lorem ipsum' };
    await workspaceController.createDocument(req, res);
    assert.strictEqual(res.statusCode, 201, 'createDocument should return 201');
    assert.strictEqual(res.jsonData.title, 'Standard SOP');
    assert.strictEqual(res.jsonData.status, 'FINAL');
  }

  // 13. createDocument - Invalid Status
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { title: 'Bad Doc', status: 'REJECTED' };
    await workspaceController.createDocument(req, res);
    assert.strictEqual(res.statusCode, 400, 'createDocument should fail with 400 for invalid status');
  }

  console.log('All unit tests passed successfully!');
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
