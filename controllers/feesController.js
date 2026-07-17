// =====================================================================
// controllers/feesController.js
// Service Fees: Recurring operating expenses and custom Finance bridge
// =====================================================================
'use strict';

const db = require('../db');

/**
 * GET /service-fees
 * List all recurring service fees for the active tenant.
 */
async function listFees(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'SELECT * FROM service_fees WHERE tenant_id = $1 ORDER BY next_due_date ASC, created_at DESC',
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[feesController] listFees failed', err);
    return res.status(500).json({ error: 'Failed to list service fees.' });
  }
}

/**
 * POST /service-fees
 * Create a new service fee under the active tenant.
 */
async function createFee(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId || req.body.branchId || null;
  const {
    feeName,
    provider,
    category = 'OTHER',
    amount = 0.00,
    currency = 'PGK',
    billingCycle = 'MONTHLY',
    nextDueDate,
    status = 'ACTIVE',
    notes
  } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!feeName) return res.status(400).json({ error: 'feeName is required.' });

  try {
    const result = await db.query(
      `INSERT INTO service_fees
          (tenant_id, branch_id, fee_name, provider, category, amount, currency, billing_cycle, next_due_date, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [tenantId, branchId, feeName, provider || null, category, amount, currency, billingCycle, nextDueDate || null, status, notes || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[feesController] createFee failed', err);
    return res.status(500).json({ error: 'Failed to create service fee.' });
  }
}

/**
 * PATCH /service-fees/:id
 * Update a service fee details.
 */
async function updateFee(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const {
    feeName,
    provider,
    category,
    amount,
    currency,
    billingCycle,
    nextDueDate,
    status,
    notes,
    branchId
  } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `UPDATE service_fees
          SET fee_name = COALESCE($1, fee_name),
              provider = COALESCE($2, provider),
              category = COALESCE($3, category),
              amount = COALESCE($4, amount),
              currency = COALESCE($5, currency),
              billing_cycle = COALESCE($6, billing_cycle),
              next_due_date = COALESCE($7, next_due_date),
              status = COALESCE($8, status),
              notes = COALESCE($9, notes),
              branch_id = COALESCE($10, branch_id),
              updated_at = NOW()
        WHERE id = $11 AND tenant_id = $12
        RETURNING *`,
      [feeName, provider, category, amount, currency, billingCycle, nextDueDate, status, notes, branchId, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Service fee not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[feesController] updateFee failed', err);
    return res.status(500).json({ error: 'Failed to update service fee.' });
  }
}

/**
 * DELETE /service-fees/:id
 * Delete a service fee safely.
 */
async function deleteFee(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM service_fees WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Service fee not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Service fee deleted successfully.' });
  } catch (err) {
    console.error('[feesController] deleteFee failed', err);
    return res.status(500).json({ error: 'Failed to delete service fee.' });
  }
}

/**
 * POST /service-fees/:id/pay
 * Functional ledger bridge.
 * Transitions fee status to 'PAID' (or marks next cycle) and logs an EXPENSE
 * transaction inside the custom core financial_transactions ledger.
 */
async function payFee(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch fee details
    const feeRes = await client.query(
      'SELECT * FROM service_fees WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, tenantId]
    );

    if (feeRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Service fee not found or not in tenant scope.' });
    }

    const fee = feeRes.rows[0];

    // 2. Transition status of service fee to PAID and roll-forward due date
    const updatedFeeRes = await client.query(
      `UPDATE service_fees
       SET
           status = 'PAID',
           next_due_date = CASE
               WHEN billing_cycle = 'MONTHLY' THEN COALESCE(next_due_date, CURRENT_DATE) + INTERVAL '1 month'
               WHEN billing_cycle = 'QUARTERLY' THEN COALESCE(next_due_date, CURRENT_DATE) + INTERVAL '3 months'
               WHEN billing_cycle = 'ANNUAL' THEN COALESCE(next_due_date, CURRENT_DATE) + INTERVAL '1 year'
               WHEN billing_cycle = 'YEARLY' THEN COALESCE(next_due_date, CURRENT_DATE) + INTERVAL '1 year'
               ELSE next_due_date
           END,
           updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, tenantId]
    );
    const updatedFee = updatedFeeRes.rows[0];

    // 3. Log EXPENSE transaction inside custom core financial_transactions ledger
    const txDesc = `Service Fee: ${fee.fee_name} via ${fee.provider || 'N/A'} (${fee.billing_cycle} payment)`;
    const txRes = await client.query(
      `INSERT INTO financial_transactions
          (tenant_id, branch_id, created_by_user_id, transaction_type, amount, currency,
           description, is_manual, verification_status, payment_gateway)
       VALUES ($1, $2, $3, 'EXPENSE', $4, $5, $6, TRUE, 'VERIFIED', 'INTERNAL_BRIDGE')
       RETURNING *`,
      [
        tenantId,
        fee.branch_id,
        (req.authUser && req.authUser.userId) || null,
        fee.amount,
        fee.currency,
        txDesc
      ]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      message: 'Service fee paid and recorded in core Finance ledger.',
      fee: updatedFee,
      transaction: txRes.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[feesController] payFee failed', err);
    return res.status(500).json({ error: 'Failed to record service fee payment.' });
  } finally {
    client.release();
  }
}

module.exports = {
  listFees,
  createFee,
  updateFee,
  deleteFee,
  payFee
};
