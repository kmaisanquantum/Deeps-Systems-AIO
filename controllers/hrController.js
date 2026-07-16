// =====================================================================
// controllers/hrController.js
// HR profile management, strictly scoped to the active tenant + branch.
// =====================================================================
'use strict';

const db = require('../db');
const eventDispatcher = require('../services/eventDispatcher');

/**
 * POST /hr/profiles
 * Add a new HR profile (staff record), optionally linked to an existing
 * user account.
 */
async function createProfile(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId || req.body.branchId || null;
  const { userId, fullName, positionTitle, salaryAmount, salaryCurrency = 'PGK', hireDate } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!fullName) return res.status(400).json({ error: 'fullName is required.' });
  if (salaryAmount != null && (typeof salaryAmount !== 'number' || salaryAmount < 0)) {
    return res.status(400).json({ error: 'salaryAmount must be a non-negative number.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO hr_profiles
          (tenant_id, branch_id, user_id, full_name, position_title, salary_amount, salary_currency, hire_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        tenantId,
        branchId,
        userId || null,
        fullName,
        positionTitle || null,
        salaryAmount ?? null,
        salaryCurrency,
        hireDate || null,
      ]
    );

    const profile = result.rows[0];

    eventDispatcher.dispatchAsync('hr.profile.created', tenantId, { profile });

    if (salaryAmount != null && salaryAmount > 0) {
      await syncPayrollTransaction(tenantId, branchId, req.authUser, fullName, salaryAmount, salaryCurrency);
    }

    return res.status(201).json(profile);
  } catch (err) {
    console.error('[hrController] createProfile failed', err);
    return res.status(500).json({ error: 'Failed to create HR profile.' });
  }
}

/**
 * PATCH /hr/profiles/:id/status
 * Update an employee's operational status (active/inactive, termination
 * date, position change) scoped strictly to the active tenant + branch.
 */
async function updateProfileStatus(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId;
  const { id } = req.params;
  const { isActive, terminationDate, positionTitle, salaryAmount } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    // Scope the lookup by tenant (and branch, when the caller is
    // branch-scoped) so one branch manager cannot mutate another
    // branch's staff records.
    const conditions = ['id = $1', 'tenant_id = $2'];
    const params = [id, tenantId];

    if (branchId) {
      params.push(branchId);
      conditions.push(`branch_id = $${params.length}`);
    }

    const lookupResult = await db.query(
      `SELECT * FROM hr_profiles WHERE ${conditions.join(' AND ')} LIMIT 1`,
      params
    );

    if (lookupResult.rowCount === 0) {
      return res.status(404).json({ error: 'HR profile not found in this tenant/branch scope.' });
    }

    const updateResult = await db.query(
      `UPDATE hr_profiles
          SET is_active = COALESCE($1, is_active),
              termination_date = COALESCE($2, termination_date),
              position_title = COALESCE($3, position_title),
              salary_amount = COALESCE($4, salary_amount)
        WHERE id = $5
        RETURNING *`,
      [isActive ?? null, terminationDate || null, positionTitle || null, salaryAmount ?? null, id]
    );

    const profile = updateResult.rows[0];

    eventDispatcher.dispatchAsync('hr.profile.status_updated', tenantId, { profile });

    if (salaryAmount != null && salaryAmount > 0) {
      await syncPayrollTransaction(tenantId, profile.branch_id, req.authUser, profile.full_name, salaryAmount, profile.salary_currency);
    }

    return res.status(200).json(profile);
  } catch (err) {
    console.error('[hrController] updateProfileStatus failed', err);
    return res.status(500).json({ error: 'Failed to update HR profile status.' });
  }
}

/**
 * GET /hr/profiles — list staff for the active tenant, optionally
 * filtered by branch.
 */
async function listProfiles(req, res) {
  const tenantId = req.tenantId;
  const { branchId, isActive } = req.query;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const conditions = ['tenant_id = $1'];
    const params = [tenantId];

    if (branchId) {
      params.push(branchId);
      conditions.push(`branch_id = $${params.length}`);
    }
    if (isActive !== undefined) {
      params.push(isActive === 'true');
      conditions.push(`is_active = $${params.length}`);
    }

    const result = await db.query(
      `SELECT * FROM hr_profiles WHERE ${conditions.join(' AND ')} ORDER BY full_name ASC`,
      params
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[hrController] listProfiles failed', err);
    return res.status(500).json({ error: 'Failed to list HR profiles.' });
  }
}

async function syncPayrollTransaction(tenantId, branchId, authUser, fullName, salaryAmount, salaryCurrency) {
  try {
    await db.query(
      `INSERT INTO financial_transactions
          (tenant_id, branch_id, created_by_user_id, transaction_type, amount, currency,
           description, is_manual, verification_status)
       VALUES ($1, $2, $3, 'PAYROLL', $4, $5, $6, TRUE, 'PENDING')`,
      [
        tenantId,
        branchId,
        (authUser && authUser.userId) || null,
        salaryAmount,
        salaryCurrency || 'PGK',
        `Payroll ledger entry for ${fullName}`,
      ]
    );
  } catch (err) {
    console.error('[hrController] syncPayrollTransaction failed:', err);
  }
}

/**
 * DELETE /hr/profiles/:id
 * Delete a profile safely under active tenant.
 */
async function deleteProfile(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM hr_profiles WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'HR profile not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'HR profile deleted successfully.' });
  } catch (err) {
    console.error('[hrController] deleteProfile error:', err);
    return res.status(500).json({ error: 'Failed to delete HR profile.' });
  }
}

module.exports = { createProfile, updateProfileStatus, listProfiles, deleteProfile };
