const assert = require('assert');
const axios = require('axios');

// Mock db queries
const db = require('./db');
let lastSavedStatus = null;

db.query = async (text, params) => {
  const queryNormalized = text.trim().replace(/\s+/g, ' ');
  if (queryNormalized.startsWith('SELECT')) {
    const id = params[0];
    const url = id === '8' ? '' : (id === '6' ? 'http://site6.com/' : `http://site${id}.com`);
    return {
      rowCount: 1,
      rows: [{ id: id, url: url }]
    };
  } else if (queryNormalized.startsWith('UPDATE')) {
    lastSavedStatus = params[0];
    return {
      rowCount: 1,
      rows: [{ id: params[1], last_status: params[0] }]
    };
  }
  return { rowCount: 0, rows: [] };
};

// Mock axios.get
const originalGet = axios.get;
axios.get = async (url, config) => {
  assert.strictEqual(config.timeout, 5000);

  if (url === 'http://site1.com/healthz') {
    return { status: 200, data: { status: 'ok' } };
  }
  if (url === 'http://site2.com/healthz') {
    return { status: 200, data: { ok: true } };
  }
  if (url === 'http://site3.com/healthz') {
    return { status: 200, data: 'healthy' };
  }
  if (url === 'http://site4.com/healthz') {
    return { status: 404, data: 'Not Found' };
  }
  if (url === 'http://site4.com') {
    return { status: 200, data: 'Welcome' };
  }
  if (url.includes('site5.com')) {
    throw new Error('timeout exceeded');
  }
  if (url === 'http://site6.com/healthz') {
    return { status: 200, data: { status: 'ok' } };
  }
  if (url === 'http://site7.com/healthz') {
    return { status: 500, data: 'Error' };
  }
  if (url === 'http://site7.com') {
    return { status: 401, data: 'Unauthorized' };
  }
  throw new Error('Unexpected URL: ' + url);
};

// Import storeController
const storeController = require('./controllers/storeController');

// Mock response creator
function mockResponse() {
  return {
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
}

async function runTests() {
  console.log('--- STARTING CONNECTED SITES MONITOR TESTS (STRICT LIVENESS) ---');

  // Test Case 1: Healthy /healthz with { status: 'ok' }
  {
    const req = { tenantId: 'tenant-123', params: { id: '1' } };
    const res = mockResponse();
    lastSavedStatus = null;
    await storeController.checkSite(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastSavedStatus, 'online');
    assert.strictEqual(res.data.last_status, 'online');
    console.log('✓ Test Case 1 passed: /healthz returning { status: "ok" } results in online.');
  }

  // Test Case 2: Healthy /healthz with { ok: true }
  {
    const req = { tenantId: 'tenant-123', params: { id: '2' } };
    const res = mockResponse();
    lastSavedStatus = null;
    await storeController.checkSite(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastSavedStatus, 'online');
    assert.strictEqual(res.data.last_status, 'online');
    console.log('✓ Test Case 2 passed: /healthz returning { ok: true } results in online.');
  }

  // Test Case 3: Healthy /healthz with string "healthy"
  {
    const req = { tenantId: 'tenant-123', params: { id: '3' } };
    const res = mockResponse();
    lastSavedStatus = null;
    await storeController.checkSite(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastSavedStatus, 'online');
    assert.strictEqual(res.data.last_status, 'online');
    console.log('✓ Test Case 3 passed: /healthz returning "healthy" text results in online.');
  }

  // Test Case 4: Unhealthy /healthz (404) but healthy fallback (200)
  {
    const req = { tenantId: 'tenant-123', params: { id: '4' } };
    const res = mockResponse();
    lastSavedStatus = null;
    await storeController.checkSite(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastSavedStatus, 'online');
    assert.strictEqual(res.data.last_status, 'online');
    console.log('✓ Test Case 4 passed: Unhealthy /healthz (404) falling back to healthy index (200) results in online.');
  }

  // Test Case 5: Completely unreachable/Timeout on both
  {
    const req = { tenantId: 'tenant-123', params: { id: '5' } };
    const res = mockResponse();
    lastSavedStatus = null;
    await storeController.checkSite(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastSavedStatus, 'offline');
    assert.strictEqual(res.data.last_status, 'offline');
    console.log('✓ Test Case 5 passed: Connection timeouts safely result in offline.');
  }

  // Test Case 6: Trailing slash sanitization
  {
    const req = { tenantId: 'tenant-123', params: { id: '6' } };
    const res = mockResponse();
    lastSavedStatus = null;
    await storeController.checkSite(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastSavedStatus, 'online');
    assert.strictEqual(res.data.last_status, 'online');
    console.log('✓ Test Case 6 passed: URL with trailing slash is properly sanitized to avoid double slashes like //healthz.');
  }

  // Test Case 7: Fallback 401 Unauthorized (< 500) results in online
  {
    const req = { tenantId: 'tenant-123', params: { id: '7' } };
    const res = mockResponse();
    lastSavedStatus = null;
    await storeController.checkSite(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastSavedStatus, 'online');
    assert.strictEqual(res.data.last_status, 'online');
    console.log('✓ Test Case 7 passed: Fallback 401 status (< 500) results in online.');
  }

  // Test Case 8: Blank/empty URL results in unknown
  {
    const req = { tenantId: 'tenant-123', params: { id: '8' } };
    const res = mockResponse();
    lastSavedStatus = null;
    await storeController.checkSite(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastSavedStatus, 'unknown');
    assert.strictEqual(res.data.last_status, 'unknown');
    console.log('✓ Test Case 8 passed: Empty/blank URL skips ping and results in unknown.');
  }

  // Restore axios
  axios.get = originalGet;

  console.log('--- ALL CONNECTED SITES MONITOR TESTS PASSED SUCCESSFULY ---');
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
