// =====================================================================
// controllers/authController.js
// Authentication controllers using native crypto module and JWT
// =====================================================================
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'deeps-systems-aio-secret-key-12345';

/**
 * Hash password using native Node.js crypto module (SHA-256)
 */
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * POST /api/auth/register
 * Register a new user under a tenant. If no tenant exists, creates one.
 */
async function register(req, res) {
  const { fullName, email, password, role = 'employee', companyName, subdomain } = req.body || {};

  if (!fullName || !email || !password) {
    return res.status(400).json({ error: 'Full name, email, and password are required.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    let tenantId = req.tenantId;

    // If no tenant is resolved, let's create one or get the default one
    if (!tenantId) {
      if (!companyName || !subdomain) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Company name and subdomain are required to create a tenant.' });
      }

      // Check if tenant subdomain already exists
      const tenantCheck = await client.query('SELECT id FROM tenants WHERE subdomain = $1 LIMIT 1', [subdomain]);
      if (tenantCheck.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Subdomain already taken.' });
      }

      const tenantInsert = await client.query(
        'INSERT INTO tenants (company_name, subdomain) VALUES ($1, $2) RETURNING id',
        [companyName, subdomain]
      );
      tenantId = tenantInsert.rows[0].id;
    }

    // Check if user already exists in this tenant
    const userCheck = await client.query('SELECT id FROM users WHERE tenant_id = $1 AND email = $2 LIMIT 1', [
      tenantId,
      email.toLowerCase(),
    ]);

    if (userCheck.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'User with this email already exists under this tenant.' });
    }

    // Insert user
    const passwordHash = hashPassword(password);
    const userInsert = await client.query(
      `INSERT INTO users (tenant_id, full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tenant_id, full_name, email, role`,
      [tenantId, fullName, email.toLowerCase(), passwordHash, role]
    );

    const user = userInsert.rows[0];
    await client.query('COMMIT');

    // Generate JWT Token
    const token = jwt.sign(
      {
        userId: user.id,
        tenantId: user.tenant_id,
        role: user.role,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(201).json({
      message: 'Registration successful.',
      token,
      user,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[authController] registration failed', err);
    return res.status(500).json({ error: 'Registration failed.' });
  } finally {
    client.release();
  }
}

/**
 * POST /api/auth/login
 * Log in an existing user and return a JWT.
 */
async function login(req, res) {
  const { email, password } = req.body || {};
  let tenantId = req.tenantId;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    let queryText = 'SELECT * FROM users WHERE email = $1';
    let queryParams = [email.toLowerCase()];

    if (tenantId) {
      queryText = 'SELECT * FROM users WHERE tenant_id = $1 AND email = $2';
      queryParams = [tenantId, email.toLowerCase()];
    }

    const result = await db.query(queryText, queryParams);

    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = result.rows[0];
    const passwordHash = hashPassword(password);

    if (user.password_hash !== passwordHash) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Your user account is suspended.' });
    }

    // Generate JWT Token
    const token = jwt.sign(
      {
        userId: user.id,
        tenantId: user.tenant_id,
        branchId: user.branch_id,
        role: user.role,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(200).json({
      message: 'Login successful.',
      token,
      user: {
        id: user.id,
        tenantId: user.tenant_id,
        branchId: user.branch_id,
        fullName: user.full_name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('[authController] login failed', err);
    return res.status(500).json({ error: 'Login failed.' });
  }
}

/**
 * GET /api/auth/me
 * Fetch current user context
 */
async function getMe(req, res) {
  if (!req.authUser) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  try {
    const result = await db.query(
      'SELECT id, tenant_id, branch_id, full_name, email, role, is_active FROM users WHERE id = $1 LIMIT 1',
      [req.authUser.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[authController] getMe failed', err);
    return res.status(500).json({ error: 'Failed to retrieve user context.' });
  }
}

module.exports = {
  register,
  login,
  getMe,
};
