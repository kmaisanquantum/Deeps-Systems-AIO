// =====================================================================
// controllers/financeController.js
// Core custom ledger endpoints, scoped strictly by tenant/branch.
// =====================================================================
'use strict';

const db = require('../db');
const akauntingService = require('../services/akauntingService');
const eventDispatcher = require('../services/eventDispatcher');

const VALID_TX_TYPES = new Set(['INCOME', 'EXPENSE', 'PAYROLL']);

/**
 * POST /finance/transactions
 * Standard logging endpoint for any financial transaction — manual or
 * gateway-originated. Prefer .logManualTransaction() for cash/manual flows.
 */
async function logTransaction(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId || req.body.branchId || null;
  const {
    transactionType,
    amount,
    currency = 'PGK',
    description,
    paymentGateway,
    gatewayReferenceId,
    isManual = false,
    verificationStatus = 'PENDING',
  } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!VALID_TX_TYPES.has(transactionType)) {
    return res.status(400).json({ error: `transactionType must be one of ${[...VALID_TX_TYPES].join(', ')}.` });
  }
  if (typeof amount !== 'number' || amount < 0) {
    return res.status(400).json({ error: 'amount must be a non-negative number.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO financial_transactions
          (tenant_id, branch_id, created_by_user_id, transaction_type, amount, currency,
           description, is_manual, verification_status, payment_gateway, gateway_reference_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        tenantId,
        branchId,
        (req.authUser && req.authUser.userId) || null,
        transactionType,
        amount,
        currency,
        description || null,
        isManual,
        verificationStatus,
        paymentGateway || null,
        gatewayReferenceId || null,
      ]
    );

    const transaction = result.rows[0];

    eventDispatcher.dispatchAsync('transaction.created', tenantId, { transaction });

    return res.status(201).json(transaction);
  } catch (err) {
    console.error('[financeController] logTransaction failed', err);
    return res.status(500).json({ error: 'Failed to log transaction.' });
  }
}

/**
 * POST /finance/transactions/manual
 * Queue a manual bank transfer or cash flow for review. Always created
 * with is_manual = true and verification_status = 'PENDING' regardless
 * of what the caller passes, since manual entries must always be reviewed.
 */
async function logManualTransaction(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId || req.body.branchId || null;
  const { transactionType, amount, currency = 'PGK', description, notes } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!VALID_TX_TYPES.has(transactionType)) {
    return res.status(400).json({ error: `transactionType must be one of ${[...VALID_TX_TYPES].join(', ')}.` });
  }
  if (typeof amount !== 'number' || amount < 0) {
    return res.status(400).json({ error: 'amount must be a non-negative number.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO financial_transactions
          (tenant_id, branch_id, created_by_user_id, transaction_type, amount, currency,
           description, is_manual, verification_status, payment_gateway)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, 'PENDING', 'CASH_OR_MANUAL')
       RETURNING *`,
      [
        tenantId,
        branchId,
        (req.authUser && req.authUser.userId) || null,
        transactionType,
        amount,
        currency,
        description || notes || null,
      ]
    );

    const transaction = result.rows[0];

    eventDispatcher.dispatchAsync('transaction.manual.queued', tenantId, { transaction });

    return res.status(201).json({
      message: 'Manual transaction queued for verification.',
      transaction,
    });
  } catch (err) {
    console.error('[financeController] logManualTransaction failed', err);
    return res.status(500).json({ error: 'Failed to queue manual transaction.' });
  }
}

/**
 * POST /finance/webhooks/invoice-reconciliation
 * Webhook handler to verify callbacks from Akaunting or financial gateways
 * and mark matching transactions as VERIFIED/FAILED.
 *
 * Expected payload shape (normalized upstream by the specific gateway
 * controller, e.g. bankingController's Kina/BSP handlers, or directly
 * from Akaunting's payment-received webhook):
 *   { gatewayReferenceId, akauntingInvoiceId, status: 'PAID'|'FAILED', amount }
 */
async function reconcileInvoicePayment(req, res) {
  const tenantId = req.tenantId;
  const { gatewayReferenceId, akauntingInvoiceId, status, amount } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!gatewayReferenceId && !akauntingInvoiceId) {
    return res.status(400).json({ error: 'gatewayReferenceId or akauntingInvoiceId is required.' });
  }

  try {
    const lookupResult = await db.query(
      `SELECT * FROM financial_transactions
        WHERE tenant_id = $1
          AND (gateway_reference_id = $2 OR akaunting_invoice_id = $3)
        LIMIT 1`,
      [tenantId, gatewayReferenceId || null, akauntingInvoiceId || null]
    );

    if (lookupResult.rowCount === 0) {
      return res.status(404).json({ error: 'No matching transaction found for reconciliation.' });
    }

    const existing = lookupResult.rows[0];
    const newStatus = status === 'PAID' ? 'VERIFIED' : status === 'FAILED' ? 'FAILED' : 'PENDING';

    if (typeof amount === 'number' && Math.abs(Number(existing.amount) - amount) > 0.01) {
      console.warn(
        `[financeController] reconciliation amount mismatch for transaction ${existing.id}: stored=${existing.amount}, webhook=${amount}`
      );
    }

    const updateResult = await db.query(
      `UPDATE financial_transactions
          SET verification_status = $1, akaunting_invoice_id = COALESCE($2, akaunting_invoice_id)
        WHERE id = $3
        RETURNING *`,
      [newStatus, akauntingInvoiceId || null, existing.id]
    );

    const transaction = updateResult.rows[0];

    // Best-effort: also record the payment against the Akaunting invoice
    // itself if we have an invoice id and the payment succeeded.
    if (newStatus === 'VERIFIED' && transaction.akaunting_invoice_id) {
      try {
        await akauntingService.recordInvoicePayment(transaction.akaunting_invoice_id, transaction.amount);
      } catch (akauntingErr) {
        console.error('[financeController] failed to sync payment to Akaunting', akauntingErr.message);
        // Do not fail the whole reconciliation over a downstream sync issue —
        // the local ledger is already the source of truth for this webhook.
      }
    }

    eventDispatcher.dispatchAsync('transaction.reconciled', tenantId, { transaction });

    return res.status(200).json(transaction);
  } catch (err) {
    console.error('[financeController] reconcileInvoicePayment failed', err);
    return res.status(500).json({ error: 'Failed to reconcile invoice payment.' });
  }
}

/**
 * GET /finance/transactions — list/filter transactions for the active tenant.
 */
async function listTransactions(req, res) {
  const tenantId = req.tenantId;
  const { branchId, verificationStatus, limit = 50, offset = 0 } = req.query;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const conditions = ['tenant_id = $1'];
    const params = [tenantId];

    if (branchId) {
      params.push(branchId);
      conditions.push(`branch_id = $${params.length}`);
    }
    if (verificationStatus) {
      params.push(verificationStatus);
      conditions.push(`verification_status = $${params.length}`);
    }

    params.push(parseInt(limit, 10) || 50);
    params.push(parseInt(offset, 10) || 0);

    const result = await db.query(
      `SELECT * FROM financial_transactions
        WHERE ${conditions.join(' AND ')}
        ORDER BY occurred_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[financeController] listTransactions failed', err);
    return res.status(500).json({ error: 'Failed to list transactions.' });
  }
}

/**
 * GET /finance/summary
 * Return aggregated financial statistics grouped by type and status.
 */
async function getFinanceSummary(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    const result = await db.query(
      `SELECT transaction_type,
              verification_status,
              SUM(amount)::NUMERIC(14,2) AS total_amount,
              COUNT(*)::int AS count
         FROM financial_transactions
        WHERE tenant_id = $1
        GROUP BY transaction_type, verification_status`,
      [tenantId]
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[financeController] getFinanceSummary failed', err);
    return res.status(500).json({ error: 'Failed to retrieve financial summary statistics.' });
  }
}

module.exports = {
  logTransaction,
  logManualTransaction,
  reconcileInvoicePayment,
  listTransactions,
  getFinanceSummary,
};
