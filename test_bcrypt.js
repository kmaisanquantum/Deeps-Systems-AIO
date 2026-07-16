// =====================================================================
// test_bcrypt.js — Bcrypt and Password Migration Hardening Tests
// =====================================================================
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const passwordUtils = require('./utils/password');

async function runBcryptTests() {
  console.log('Running Bcrypt and Password Migration unit tests...');

  // 1. Test Legacy SHA-256 Fallback and Verification
  const plaintext = 'KapisRocket@2026';
  const legacyHash = crypto.createHash('sha256').update(plaintext).digest('hex');

  const legacyVerify = await passwordUtils.verifyPassword(plaintext, legacyHash);
  assert.strictEqual(legacyVerify.ok, true, 'Legacy verification must succeed for valid plaintext.');
  assert.strictEqual(legacyVerify.needsUpgrade, true, 'Legacy verification must indicate needsUpgrade=true.');

  const legacyVerifyFail = await passwordUtils.verifyPassword('wrongpassword', legacyHash);
  assert.strictEqual(legacyVerifyFail.ok, false, 'Legacy verification must fail for invalid plaintext.');

  // 2. Test Bcrypt Hashing and Verification
  const bcryptHash = await passwordUtils.hashPassword(plaintext);
  assert(bcryptHash.startsWith('$2'), 'Bcrypt hash should match standard serialization prefix.');

  const bcryptVerify = await passwordUtils.verifyPassword(plaintext, bcryptHash);
  assert.strictEqual(bcryptVerify.ok, true, 'Bcrypt verification must succeed for valid plaintext.');
  assert.strictEqual(bcryptVerify.needsUpgrade, false, 'Bcrypt verification must not request upgrade.');

  const bcryptVerifyFail = await passwordUtils.verifyPassword('wrongpassword', bcryptHash);
  assert.strictEqual(bcryptVerifyFail.ok, false, 'Bcrypt verification must fail for invalid plaintext.');

  // 3. Test Insecure JWT Secret Production Hardening
  const oldEnv = process.env.NODE_ENV;
  const oldSecret = process.env.JWT_SECRET;

  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'deeps-systems-aio-secret-key-12345';

  assert.throws(() => {
    // Attempting to require files that run the check
    delete require.cache[require.resolve('./controllers/authController')];
    require('./controllers/authController');
  }, /FATAL SECURITY EXCEPTION/, 'Should throw fatal initialization error if JWT_SECRET is default fallback in production.');

  // Restore env
  process.env.NODE_ENV = oldEnv;
  process.env.JWT_SECRET = oldSecret;

  console.log('All Bcrypt and Password Migration unit tests passed successfully!');
}

runBcryptTests().catch(err => {
  console.error('Bcrypt test suite failed:', err);
  process.exit(1);
});
