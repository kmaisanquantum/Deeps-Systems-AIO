// =====================================================================
// controllers/adminController.js
// Admin Module: Tenant-scoped user, branch, and tenant management.
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
 * Last Admin Guard evaluation logic
 * Returns true if the change is permitted, or false if it would remove the last active admin.
 * @param {string} tenantId
 * @param {string} targetUserId
 * @param {string|null} newRole - If changing role, the proposed role (or null if no role change)
 * @param {boolean|null} newIsActive - If changing is_active, the proposed state (or null if no change)
 * @param {boolean} isDeletion - If performing a deletion
 */
async function checkLastAdminGuard(tenantId, targetUserId, newRole = null, newIsActive = null, isDeletion = false) {
  // 1. Fetch current details of the target user
  const userResult = await db.query(
    'SELECT role, is_active FROM users WHERE id = $1 AND tenant_id = $2',
    [targetUserId, tenantId]
  );
  if (userResult.rowCount === 0) {
    return true; // Let downstream handler return 404
  }

  const user = userResult.rows[0];
  const isTargetActiveAdmin = (user.role === 'admin' && user.is_active === true);

  // If the target is not currently an active admin, any action on them won't remove the last active admin
  if (!isTargetActiveAdmin) {
    return true;
  }

  // If the target IS currently an active admin, check if we are removing their admin status
  const losingAdminStatus = isDeletion ||
    (newRole !== null && newRole !== 'admin') ||
    (newIsActive !== null && newIsActive === false);

  if (!losingAdminStatus) {
    return true; // Role/status is not changing to non-admin/inactive
  }

  // 2. Count active admins in this tenant
  const countResult = await db.query(
    "SELECT count(*) FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true",
    [tenantId]
  );
  const activeAdminCount = parseInt(countResult.rows[0].count, 10);

  // If there's only 1 active admin (which must be this target), block the action
  if (activeAdminCount <= 1) {
    return false;
  }

  return true;
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
      [tenantId, email.toLowerCase().trim()]
    );
    if (userCheck.rowCount > 0) {
      return res.status(400).json({ error: 'User with this email already exists under this tenant.' });
    }

    // Validate branch_id if provided
    if (branchId) {
      const branchCheck = await db.query(
        'SELECT id FROM branches WHERE id = $1 AND tenant_id = $2',
        [branchId, tenantId]
      );
      if (branchCheck.rowCount === 0) {
        return res.status(400).json({ error: 'Invalid branch for this tenant.' });
      }
    }

    const passwordHash = hashPassword(password);
    const result = await db.query(
      `INSERT INTO users (tenant_id, branch_id, full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, tenant_id, branch_id, full_name, email, role, is_active, created_at`,
      [tenantId, branchId, fullName, email.toLowerCase().trim(), passwordHash, role]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[adminController] createUser Error:', err);
    return res.status(500).json({ error: 'Failed to create user.' });
  }
}

/**
 * PATCH /admin/users/:id
 * Handle partial updates for a user profile.
 */
async function updateUser(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { full_name, email, role, branch_id, is_active } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  // Guard against self-demotion / self-suspension
  const isSelf = (String(id) === String(req.authUser.userId));
  if (isSelf) {
    if (role && role !== 'admin') {
      return res.status(400).json({ error: 'Self-demotion is not allowed. You cannot change your own role.' });
    }
    if (is_active !== undefined && !is_active) {
      return res.status(400).json({ error: 'Self-suspension is not allowed. You cannot change your own status.' });
    }
  }

  // Handle email cleansing
  const cleansedEmail = email ? email.toLowerCase().trim() : null;

  // Validate inputs if specified
  if (role) {
    const allowedRoles = ['admin', 'manager', 'employee'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${allowedRoles.join(', ')}` });
    }
  }

  try {
    // Evaluate Last Admin Guard
    const passesGuard = await checkLastAdminGuard(
      tenantId,
      id,
      role || null,
      is_active !== undefined ? is_active : null,
      false
    );
    if (!passesGuard) {
      return res.status(400).json({ error: 'Cannot remove or demote the last active admin.' });
    }

    // Check email uniqueness under same tenant
    if (cleansedEmail) {
      const emailCheck = await db.query(
        'SELECT id FROM users WHERE tenant_id = $1 AND email = $2 AND id <> $3 LIMIT 1',
        [tenantId, cleansedEmail, id]
      );
      if (emailCheck.rowCount > 0) {
        return res.status(400).json({ error: 'User with this email already exists under this tenant.' });
      }
    }

    // Validate branch ownership
    if (branch_id) {
      const branchCheck = await db.query(
        'SELECT id FROM branches WHERE id = $1 AND tenant_id = $2',
        [branch_id, tenantId]
      );
      if (branchCheck.rowCount === 0) {
        return res.status(400).json({ error: 'Invalid branch for this tenant.' });
      }
    }

    // Execute coalesce patch
    const result = await db.query(
      `UPDATE users
          SET full_name = COALESCE($1, full_name),
              email = COALESCE($2, email),
              role = COALESCE($3, role),
              branch_id = CASE WHEN $4::uuid IS NULL THEN branch_id ELSE $4 END,
              is_active = COALESCE($5, is_active),
              updated_at = now()
        WHERE id = $6 AND tenant_id = $7
        RETURNING id, tenant_id, branch_id, full_name, email, role, is_active, created_at`,
      [full_name, cleansedEmail, role, branch_id || null, is_active !== undefined ? is_active : null, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[adminController] updateUser Error:', err);
    // Unique constraint key error
    if (err.code === '23505') {
      return res.status(400).json({ error: 'User with this email already exists under this tenant.' });
    }
    return res.status(500).json({ error: 'Failed to update user.' });
  }
}

/**
 * DELETE /admin/users/:id
 * Delete a user profile under active tenant context.
 */
async function deleteUser(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  // Prevent administrative self-deletion
  if (String(id) === String(req.authUser.userId)) {
    return res.status(400).json({ error: 'Self-deletion is not allowed.' });
  }

  try {
    // Last Admin Guard evaluation
    const passesGuard = await checkLastAdminGuard(tenantId, id, null, null, true);
    if (!passesGuard) {
      return res.status(400).json({ error: 'Cannot remove or demote the last active admin.' });
    }

    const result = await db.query(
      'DELETE FROM users WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'User deleted successfully.' });
  } catch (err) {
    console.error('[adminController] deleteUser Error:', err);
    return res.status(500).json({ error: 'Failed to delete user.' });
  }
}

/**
 * PATCH /admin/users/:id/role
 * Update a user's role. Protects against self-demotion. Enforces Last Admin Guard.
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
  if (String(id) === String(req.authUser.userId)) {
    return res.status(400).json({ error: 'Self-demotion is not allowed. You cannot change your own role.' });
  }

  try {
    const passesGuard = await checkLastAdminGuard(tenantId, id, role, null, false);
    if (!passesGuard) {
      return res.status(400).json({ error: 'Cannot remove or demote the last active admin.' });
    }

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
 * Suspend/reactivate a user. Protects against self-suspension. Enforces Last Admin Guard.
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
  if (String(id) === String(req.authUser.userId)) {
    return res.status(400).json({ error: 'Self-suspension is not allowed. You cannot change your own status.' });
  }

  try {
    const passesGuard = await checkLastAdminGuard(tenantId, id, null, !!isActive, false);
    if (!passesGuard) {
      return res.status(400).json({ error: 'Cannot remove or demote the last active admin.' });
    }

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

/**
 * GET /admin/branches
 * List all operational branches for specific tenant.
 */
async function listBranches(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    const result = await db.query(
      `SELECT id, tenant_id, branch_name, location_city, is_hub, created_at
         FROM branches
        WHERE tenant_id = $1
        ORDER BY created_at DESC`,
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[adminController] listBranches Error:', err);
    return res.status(500).json({ error: 'Failed to list branches.' });
  }
}

/**
 * POST /admin/branches
 * Insert a branch configuration under active tenant.
 */
async function createBranch(req, res) {
  const tenantId = req.tenantId;
  const { branch_name, location_city, is_hub } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }
  if (!branch_name) {
    return res.status(400).json({ error: 'branch_name is required.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO branches (tenant_id, branch_name, location_city, is_hub)
       VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, branch_name, location_city, is_hub, created_at`,
      [tenantId, branch_name, location_city || null, is_hub === true]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[adminController] createBranch Error:', err);
    return res.status(500).json({ error: 'Failed to create branch.' });
  }
}

/**
 * PATCH /admin/branches/:id
 * Dynamic partial modification via COALESCE.
 */
async function updateBranch(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { branch_name, location_city, is_hub } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    const result = await db.query(
      `UPDATE branches
          SET branch_name = COALESCE($1, branch_name),
              location_city = COALESCE($2, location_city),
              is_hub = COALESCE($3, is_hub),
              updated_at = now()
        WHERE id = $4 AND tenant_id = $5
        RETURNING id, tenant_id, branch_name, location_city, is_hub, created_at`,
      [branch_name, location_city, is_hub !== undefined ? is_hub : null, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Branch not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[adminController] updateBranch Error:', err);
    return res.status(500).json({ error: 'Failed to update branch.' });
  }
}

/**
 * DELETE /admin/branches/:id
 * Delete branch rows safely.
 */
async function deleteBranch(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    const result = await db.query(
      'DELETE FROM branches WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Branch not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Branch deleted successfully.' });
  } catch (err) {
    console.error('[adminController] deleteBranch Error:', err);
    return res.status(500).json({ error: 'Failed to delete branch.' });
  }
}

/**
 * GET /admin/tenant
 * Fetch details of active tenant safely.
 */
async function getTenant(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    const result = await db.query(
      `SELECT id, company_name, subdomain, is_active
         FROM tenants
        WHERE id = $1 LIMIT 1`,
      [tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[adminController] getTenant Error:', err);
    return res.status(500).json({ error: 'Failed to fetch tenant configuration.' });
  }
}

/**
 * PATCH /admin/tenant
 * Allow modifying company_name only. Restrict subdomain edits.
 */
async function updateTenant(req, res) {
  const tenantId = req.tenantId;
  const { company_name, subdomain } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }
  if (!company_name) {
    return res.status(400).json({ error: 'company_name is required.' });
  }
  if (subdomain !== undefined) {
    return res.status(400).json({ error: 'Subdomain parameter cannot be modified.' });
  }

  try {
    const result = await db.query(
      `UPDATE tenants
          SET company_name = $1, updated_at = now()
        WHERE id = $2
        RETURNING id, company_name, subdomain, is_active`,
      [company_name, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[adminController] updateTenant Error:', err);
    return res.status(500).json({ error: 'Failed to update tenant configuration.' });
  }
}

/**
 * PATCH /admin/users/:id/branch
 * Safely alter branch_id after verifying branch ownership.
 */
async function assignUserBranch(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { branch_id, branchId } = req.body || {};
  const targetBranchId = branch_id || branchId || null;

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    if (targetBranchId) {
      const branchCheck = await db.query(
        'SELECT id FROM branches WHERE id = $1 AND tenant_id = $2',
        [targetBranchId, tenantId]
      );
      if (branchCheck.rowCount === 0) {
        return res.status(400).json({ error: 'Invalid branch for this tenant.' });
      }
    }

    const result = await db.query(
      `UPDATE users
          SET branch_id = $1, updated_at = now()
        WHERE id = $2 AND tenant_id = $3
        RETURNING id, tenant_id, branch_id, full_name, email, role, is_active`,
      [targetBranchId, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[adminController] assignUserBranch Error:', err);
    return res.status(500).json({ error: 'Failed to assign branch to user.' });
  }
}

const updateUserDetails = updateUser;

module.exports = {
  listUsers,
  createUser,
  updateUser,
  updateUserDetails,
  deleteUser,
  updateUserRole,
  resetUserPassword,
  updateUserStatus,
  assignUserBranch,
  listBranches,
  createBranch,
  updateBranch,
  deleteBranch,
  getTenant,
  updateTenant,
};
