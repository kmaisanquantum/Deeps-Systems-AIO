// =====================================================================
// controllers/superadminController.js
// Centralized platform-wide operations for superadmins.
// Strictly guards access to superadmins and ensures zero password_hash leaks.
// =====================================================================
'use strict';

const db = require('../db');

/**
 * GET /api/superadmin/tenants
 * Retrieve all tenants across the platform.
 */
async function listTenants(req, res) {
  try {
    const result = await db.query(
      'SELECT id, company_name, subdomain, is_active, created_at, updated_at FROM tenants ORDER BY created_at DESC'
    );
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('[superadminController] listTenants error:', error);
    return res.status(500).json({ error: 'Failed to retrieve tenants.' });
  }
}

/**
 * POST /api/superadmin/tenants
 * Register a new corporate tenant from the centralized panel.
 */
async function createTenant(req, res) {
  const { companyName, subdomain, isActive = true } = req.body || {};

  if (!companyName || !subdomain) {
    return res.status(400).json({ error: 'companyName and subdomain are required.' });
  }

  try {
    // Check subdomain uniqueness
    const existing = await db.query('SELECT id FROM tenants WHERE subdomain = $1 LIMIT 1', [subdomain.toLowerCase()]);
    if (existing.rowCount > 0) {
      return res.status(400).json({ error: 'Subdomain already taken.' });
    }

    const result = await db.query(
      `INSERT INTO tenants (company_name, subdomain, is_active)
       VALUES ($1, $2, $3)
       RETURNING id, company_name, subdomain, is_active, created_at, updated_at`,
      [companyName, subdomain.toLowerCase(), isActive]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('[superadminController] createTenant error:', error);
    return res.status(500).json({ error: 'Failed to create tenant.' });
  }
}

/**
 * PATCH /api/superadmin/tenants/:id
 * Toggle tenant active status or update details.
 */
async function updateTenantStatus(req, res) {
  const { id } = req.params;
  const { companyName, subdomain, isActive } = req.body || {};

  try {
    // If updating subdomain, make sure it is not taken
    if (subdomain) {
      const existing = await db.query(
        'SELECT id FROM tenants WHERE subdomain = $1 AND id != $2 LIMIT 1',
        [subdomain.toLowerCase(), id]
      );
      if (existing.rowCount > 0) {
        return res.status(400).json({ error: 'Subdomain already taken.' });
      }
    }

    const result = await db.query(
      `UPDATE tenants
          SET company_name = COALESCE($1, company_name),
              subdomain = COALESCE($2, subdomain),
              is_active = COALESCE($3, is_active),
              updated_at = now()
        WHERE id = $4
        RETURNING id, company_name, subdomain, is_active, created_at, updated_at`,
      [companyName || null, subdomain ? subdomain.toLowerCase() : null, isActive !== undefined ? isActive : null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('[superadminController] updateTenantStatus error:', error);
    return res.status(500).json({ error: 'Failed to update tenant.' });
  }
}

/**
 * GET /api/superadmin/users
 * Search and list all user accounts platform-wide (excludes password_hash).
 */
async function listAllUsers(req, res) {
  try {
    const result = await db.query(
      `SELECT u.id, u.tenant_id, t.company_name AS tenant_name, u.branch_id, u.full_name, u.email, u.role, u.is_active, u.created_at
         FROM users u
         LEFT JOIN tenants t ON u.tenant_id = t.id
        ORDER BY u.created_at DESC`
    );
    // Explicitly delete password_hash from response objects for defense in depth
    const cleanedRows = result.rows.map(row => {
      const { password_hash, ...rest } = row;
      return rest;
    });
    return res.status(200).json(cleanedRows);
  } catch (error) {
    console.error('[superadminController] listAllUsers error:', error);
    return res.status(500).json({ error: 'Failed to retrieve user directory.' });
  }
}

/**
 * PATCH /api/superadmin/users/:id
 * Reassign user tenant or change role platform-wide (excludes password_hash).
 */
async function updateUserTenantOrRole(req, res) {
  const { id } = req.params;
  const { tenantId, role, isActive } = req.body || {};

  try {
    const result = await db.query(
      `UPDATE users
          SET tenant_id = COALESCE($1, tenant_id),
              role = COALESCE($2, role),
              is_active = COALESCE($3, is_active),
              updated_at = now()
        WHERE id = $4
        RETURNING id, tenant_id, branch_id, full_name, email, role, is_active, created_at, updated_at`,
      [tenantId || null, role || null, isActive !== undefined ? isActive : null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Explicitly delete password_hash from response objects for defense in depth
    const cleanedRows = result.rows.map(row => {
      const { password_hash, ...rest } = row;
      return rest;
    });
    return res.status(200).json(cleanedRows[0]);
  } catch (error) {
    console.error('[superadminController] updateUserTenantOrRole error:', error);
    return res.status(500).json({ error: 'Failed to update user context.' });
  }
}

module.exports = {
  listTenants,
  createTenant,
  updateTenantStatus,
  listAllUsers,
  updateUserTenantOrRole,
};
