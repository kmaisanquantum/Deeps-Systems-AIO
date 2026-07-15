// =====================================================================
// db.js — shared PostgreSQL connection pool
// =====================================================================
'use strict';

const { Pool } = require('pg');

let pool;
if (process.env.MOCK_DB !== 'true') {
  if (!process.env.DATABASE_URL) {
    // Fail loudly at boot rather than silently connecting to nothing.
    console.warn('[db] WARNING: DATABASE_URL is not set. Database calls will fail.');
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    // Unexpected errors on idle clients shouldn't crash the whole process.
    console.error('[db] Unexpected error on idle PostgreSQL client', err);
  });
}

/**
 * Run a parameterized query against the pool.
 * @param {string} text
 * @param {Array} params
 */
async function query(text, params) {
  if (process.env.MOCK_DB === 'true') {
    return { rows: [], rowCount: 0 };
  }
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.LOG_SQL === 'true') {
    console.log('[db] query executed', { text, duration, rows: result.rowCount });
  }
  return result;
}

/**
 * Acquire a client for manual transaction control (BEGIN/COMMIT/ROLLBACK).
 */
async function getClient() {
  if (process.env.MOCK_DB === 'true') {
    return {
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => {}
    };
  }
  const client = await pool.connect();
  return client;
}

module.exports = { pool, query, getClient };
