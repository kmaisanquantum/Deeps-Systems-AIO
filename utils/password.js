// =====================================================================
// utils/password.js
// Unified hashing layer supporting bcryptjs and legacy un-salted SHA-256 fallback.
// =====================================================================
'use strict';

const crypto = require('crypto');
const bcryptjs = require('bcryptjs');

/**
 * Generates a salted bcrypt hash using a cost factor of 12 rounds.
 * @param {string} plainText
 * @returns {Promise<string>}
 */
async function hashPassword(plainText) {
  if (!plainText) {
    throw new Error('Plaintext password is required for hashing.');
  }
  return await bcryptjs.hash(plainText, 12);
}

/**
 * Returns a verification result object containing { ok: boolean, needsUpgrade: boolean }.
 * Supports standard bcrypt and legacy un-salted SHA-256.
 * @param {string} plainText
 * @param {string} storedHash
 * @returns {Promise<{ ok: boolean, needsUpgrade: boolean }>}
 */
async function verifyPassword(plainText, storedHash) {
  if (!plainText || !storedHash) {
    return { ok: false, needsUpgrade: false };
  }

  // 1. Bcrypt Resolution (expression matches structural prefix $2)
  if (storedHash.startsWith('$2')) {
    try {
      const match = await bcryptjs.compare(plainText, storedHash);
      return { ok: match, needsUpgrade: false };
    } catch (err) {
      console.error('[passwordUtils] bcrypt verification error:', err);
      return { ok: false, needsUpgrade: false };
    }
  }

  // 2. Legacy Algorithm Fallback (SHA-256 un-salted hex digest)
  try {
    if (storedHash.length !== 64) {
      return { ok: false, needsUpgrade: false };
    }

    const targetHashHex = crypto.createHash('sha256').update(plainText).digest('hex');

    // Use constant-time execution check (crypto.timingSafeEqual)
    const buf1 = Buffer.from(targetHashHex, 'utf8');
    const buf2 = Buffer.from(storedHash, 'utf8');

    if (buf1.length === buf2.length && crypto.timingSafeEqual(buf1, buf2)) {
      return { ok: true, needsUpgrade: true };
    }
  } catch (err) {
    console.error('[passwordUtils] legacy sha256 fallback verification error:', err);
  }

  return { ok: false, needsUpgrade: false };
}

module.exports = {
  hashPassword,
  verifyPassword,
};
