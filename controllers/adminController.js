// =====================================================================
// controllers/adminController.js
// Admin Module: Tenant-scoped user management.
// Strictly tenant-isolated.
// =====================================================================
'use strict';

const crypto = require('crypto');
const db = require('../db');

/**
 * Hash password using SHA-256
 */
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * GET /admin/users
 * List all users under the active tenant.
 */
async function listUsers(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    const result = await db.query(
      `SELECT id, full_name, email, role, is_active, branch_id, created_at
         FROM users
        WHERE tenant_id = $1
        ORDER BY created_at DESC`,
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[adminController] listUsers Error:', err);
    return res.status(500).json({ error: 'Failed to list users.' });
  }
}

/**
 * POST /admin/users
 * Create a new user under the active tenant.
 */
async function createUser(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId || req.body.branchId || null;
  const { fullName, email, password, role } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }
  if (!fullName || !email || !password || !role) {
    return res.status(400).json({ error: 'fullName, email, password, and role are required.' });
  }

  const allowedRoles = ['admin', 'manager', 'employee'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${allowedRoles.join(', ')}` });
  }

  try {
    // Check if user already exists under this tenant
    const userCheck = await db.query(
      'SELECT id FROM users WHERE tenant_id = $1 AND email = $2 LIMIT 1',
      [tenantId, email.toLowerCase()]
    );
    if (userCheck.rowCount > 0) {
      return res.status(400).json({ error: 'User with this email already exists under this tenant.' });
    }

    const passwordHash = hashPassword(password);
    const result = await db.query(
      `INSERT INTO users (tenant_id, branch_id, full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, tenant_id, branch_id, full_name, email, role, is_active, created_at`,
      [tenantId, branchId, fullName, email.toLowerCase(), passwordHash, role]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[adminController] createUser Error:', err);
    return res.status(500).json({ error: 'Failed to create user.' });
  }
}

/**
 * PATCH /admin/users/:id/role
 * Update a user's role. Protects against self-demotion.
 */
async function updateUserRole(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { role } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }
  if (!role) {
    return res.status(400).json({ error: 'role is required.' });
  }

  const allowedRoles = ['admin', 'manager', 'employee'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${allowedRoles.join(', ')}` });
  }

  // Guard against self-demotion
  if (id === req.authUser.userId) {
    return res.status(400).json({ error: 'Self-demotion is not allowed. You cannot change your own role.' });
  }

  try {
    const result = await db.query(
      `UPDATE users
          SET role = $1, updated_at = now()
        WHERE id = $2 AND tenant_id = $3
        RETURNING id, full_name, email, role, is_active, created_at`,
      [role, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[adminController] updateUserRole Error:', err);
    return res.status(500).json({ error: 'Failed to update user role.' });
  }
}

/**
 * PATCH /admin/users/:id/password
 * Reset a user's password.
 */
async function resetUserPassword(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { password } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }
  if (!password) {
    return res.status(400).json({ error: 'password is required.' });
  }

  try {
    const passwordHash = hashPassword(password);
    const result = await db.query(
      `UPDATE users
          SET password_hash = $1, updated_at = now()
        WHERE id = $2 AND tenant_id = $3
        RETURNING id, full_name, email, role, is_active, created_at`,
      [passwordHash, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Password reset successfully.' });
  } catch (err) {
    console.error('[adminController] resetUserPassword Error:', err);
    return res.status(500).json({ error: 'Failed to reset password.' });
  }
}

/**
 * PATCH /admin/users/:id/status
 * Suspend/reactivate a user. Protects against self-suspension.
 */
async function updateUserStatus(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { isActive } = req.body; // boolean

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }
  if (isActive === undefined) {
    return res.status(400).json({ error: 'isActive is required.' });
  }

  // Guard against self-suspension
  if (id === req.authUser.userId) {
    return res.status(400).json({ error: 'Self-suspension is not allowed. You cannot change your own status.' });
  }

  try {
    const result = await db.query(
      `UPDATE users
          SET is_active = $1, updated_at = now()
        WHERE id = $2 AND tenant_id = $3
        RETURNING id, full_name, email, role, is_active, created_at`,
      [!!isActive, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[adminController] updateUserStatus Error:', err);
    return res.status(500).json({ error: 'Failed to update user status.' });
  }
}

module.exports = {
  listUsers,
  createUser,
  updateUserRole,
  resetUserPassword,
  updateUserStatus,
};
