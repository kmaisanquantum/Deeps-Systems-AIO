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
    const queryLower = (text || '').toLowerCase();
    let rows = [];
    let rowCount = 0;

    console.log('[db mock] received query:', text);

    if (queryLower.includes('insert into tenants')) {
      rows = [{ id: 'mock-tenant-id-123' }];
      rowCount = 1;
    } else if (queryLower.includes('insert into users')) {
      rows = [{ id: 'mock-user-id-123' }];
      rowCount = 1;
    } else if (queryLower.includes('select id, password_hash, role, tenant_id from users')) {
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync("SecurePassword123!", 10);
      rows = [{
        id: 'mock-user-id-123',
        password_hash: hash,
        role: 'superadmin',
        tenant_id: 'mock-tenant-id-123'
      }];
      rowCount = 1;
    } else if (queryLower.includes('select id from users where tenant_id')) {
      rows = [];
      rowCount = 0;
    } else if (queryLower.includes('from tenants')) {
      if (queryLower.includes('where subdomain')) {
        rows = [];
        rowCount = 0;
      } else {
        rows = [{
          id: 'mock-tenant-id-123',
          company_name: 'Mock Company',
          subdomain: 'mock-subdomain',
          is_active: true
        }];
        rowCount = 1;
      }
    } else if (queryLower.includes('select pgp_sym_decrypt')) {
      rows = [{
        secret: 'mock-api-key',
        base_url: 'https://app.coolify.io/api/v1'
      }];
      rowCount = 1;
    } else if (queryLower.includes('from connected_sites')) {
      if (queryLower.includes('limit 1')) {
        rows = [];
        rowCount = 0;
      } else {
        rows = [
          {
            id: 'mock-site-1',
            tenant_id: 'mock-tenant-id-123',
            label: 'Storefront Portal',
            url: 'https://store.deeps.systems',
            last_status: 'online',
            last_checked_at: new Date()
          },
          {
            id: 'mock-site-2',
            tenant_id: 'mock-tenant-id-123',
            label: 'Coolify Backend',
            url: 'https://coolify.deeps.systems',
            last_status: 'offline',
            last_checked_at: new Date()
          }
        ];
        rowCount = 2;
      }
    }

    return { rows, rowCount };
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
      query: query,
      release: () => {}
    };
  }
  const client = await pool.connect();
  return client;
}

module.exports = { pool, query, getClient };
