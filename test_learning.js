// =====================================================================
// test_learning.js
// Unit tests for controllers/learningController.js & services/autonomousMonitor.js
// =====================================================================
'use strict';

const assert = require('assert');

// Mock db.js dependency before requiring the controllers
const mockDb = {
  queries: [],
  query: async function(text, params) {
    this.queries.push({ text, params });
    if (text.startsWith('SELECT * FROM learning_resources')) {
      return { rows: [{ id: 'resource-1', title: 'Resource 1', url: 'https://test.com', tenant_id: params[0] }] };
    }
    if (text.startsWith('SELECT s.*, r.title AS resource_title')) {
      return { rows: [{ id: 'schedule-1', title: 'Schedule 1', tenant_id: params[0], scheduled_at: '2026-08-01T10:00:00Z', duration_minutes: 60 }] };
    }
    if (text.startsWith('INSERT INTO study_schedule')) {
      // Return the inserted row with the passed parameters
      return { rows: [{ id: 'schedule-2', title: params[2], tenant_id: params[0], reminder_email: params[9], reminder_lead_minutes: params[10] }] };
    }
    if (text.startsWith('UPDATE study_schedule')) {
      // In update, params[8] is reminderEmail, params[9] is parsedLeadMinutes, params[10] is id, params[11] is tenant_id
      return { rowCount: 1, rows: [{ id: params[10], tenant_id: params[11], reminder_email: params[8], reminder_lead_minutes: params[9] }] };
    }
    if (text.startsWith('SELECT id, name FROM tenants')) {
      return { rows: [{ id: 'tenant-123', name: 'Test Tenant' }] };
    }
    if (text.includes('study_schedule') && text.includes('reminded_at IS NULL')) {
      return { rows: [{ id: 'schedule-due', title: 'Session Due', scheduled_at: new Date(Date.now() + 10 * 60000).toISOString(), duration_minutes: 45, reminder_email: 'test@example.com', notes: 'Prepare slides' }] };
    }
    return { rows: [], rowCount: 0 };
  },
  reset: function() {
    this.queries = [];
  }
};

// Override the module cache for '../db'
require.cache[require.resolve('./db')] = {
  id: require.resolve('./db'),
  filename: require.resolve('./db'),
  loaded: true,
  exports: mockDb
};

// Mock communicationController
const mockCommController = {
  sentEmails: [],
  sendEmailMessage: async function(to, subject, message, attachments) {
    this.sentEmails.push({ to, subject, message, attachments });
    return { messageId: 'mock-id' };
  },
  reset: function() {
    this.sentEmails = [];
  }
};

require.cache[require.resolve('./controllers/communicationController')] = {
  id: require.resolve('./controllers/communicationController'),
  filename: require.resolve('./controllers/communicationController'),
  loaded: true,
  exports: mockCommController
};

// Mock other controllers used by autonomous monitor so they don't fail
require.cache[require.resolve('./controllers/financeController')] = {
  exports: { getFinanceSummary: async (req, res) => res.json({}) }
};
require.cache[require.resolve('./controllers/feesController')] = {
  exports: { listFees: async (req, res) => res.json([]) }
};
require.cache[require.resolve('./controllers/devopsController')] = {
  exports: { listNodes: async (req, res) => res.json([]) }
};
require.cache[require.resolve('./controllers/storeController')] = {
  exports: { listSites: async (req, res) => res.json([]) }
};

const learningController = require('./controllers/learningController');
const autonomousMonitor = require('./services/autonomousMonitor');

// Helper to construct mock Express request and response
function mockReqRes(reqData = {}) {
  const req = {
    tenantId: 'tenant-123',
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
  console.log('Running Learning Module unit tests...');

  // 1. createSchedule - with defaults
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { title: 'SQL Session' };
    await learningController.createSchedule(req, res);
    assert.strictEqual(res.statusCode, 201, 'createSchedule should return 201');
    assert.strictEqual(res.jsonData.reminder_email, 'kmaisan@dspng.tech', 'reminder_email should default to kmaisan@dspng.tech');
    assert.strictEqual(res.jsonData.reminder_lead_minutes, 60, 'reminder_lead_minutes should default to 60');
  }

  // 2. createSchedule - with explicit reminder email and lead minutes
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.body = { title: 'Quantum Session', reminderEmail: 'quantum@dspng.tech', reminderLeadMinutes: 30 };
    await learningController.createSchedule(req, res);
    assert.strictEqual(res.statusCode, 201, 'createSchedule should return 201');
    assert.strictEqual(res.jsonData.reminder_email, 'quantum@dspng.tech', 'reminder_email should match explicitly provided value');
    assert.strictEqual(res.jsonData.reminder_lead_minutes, 30, 'reminder_lead_minutes should match explicitly provided value');
  }

  // 3. updateSchedule - updating reminder parameters
  {
    mockDb.reset();
    const { req, res } = mockReqRes();
    req.params = { id: 'schedule-123' };
    req.body = { reminderEmail: 'updated@dspng.tech', reminderLeadMinutes: 45 };
    await learningController.updateSchedule(req, res);
    assert.strictEqual(res.statusCode, 200, 'updateSchedule should return 200');
    assert.strictEqual(res.jsonData.reminder_email, 'updated@dspng.tech', 'reminder_email should update successfully');
    assert.strictEqual(res.jsonData.reminder_lead_minutes, 45, 'reminder_lead_minutes should update successfully');
  }

  // 4. Test background monitor sweep
  {
    mockDb.reset();
    mockCommController.reset();

    // Configure Hostgator SMTP so the sweep is not skipped
    process.env.HOSTGATOR_SMTP_HOST = 'smtp.hostgator.com';

    await autonomousMonitor.runMonitorTick();

    // Verify study_schedule query was made
    const sweepQuery = mockDb.queries.find(q => q.text.includes('SELECT * FROM study_schedule'));
    assert.ok(sweepQuery, 'Should run query against study_schedule to sweep due reminders');

    // Verify email was sent
    assert.strictEqual(mockCommController.sentEmails.length, 1, 'Should send exactly 1 email for the due study session');
    const sentEmail = mockCommController.sentEmails[0];
    assert.strictEqual(sentEmail.to, 'test@example.com', 'Recipient should match row.reminder_email');
    assert.strictEqual(sentEmail.subject, 'Study Session Reminder: Session Due');
    assert.ok(sentEmail.attachments, 'Email must have attachments');
    assert.strictEqual(sentEmail.attachments[0].filename, 'study.ics');
    assert.ok(sentEmail.attachments[0].content.includes('BEGIN:VCALENDAR'), 'ICS content should start with VCALENDAR');
    assert.ok(sentEmail.attachments[0].content.includes('SUMMARY:Session Due'), 'ICS summary should match row.title');

    // Verify reminded_at update was made
    const updateQuery = mockDb.queries.find(q => q.text.includes('UPDATE study_schedule SET reminded_at = NOW()'));
    assert.ok(updateQuery, 'Should mark session as reminded in the database');
  }

  console.log('All Learning Module unit tests passed successfully!');
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});