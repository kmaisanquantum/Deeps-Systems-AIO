// =====================================================================
// controllers/bankingController.js
// Regional PNG banking gateway integrations: BSP Pay + Kina Bank IPG.
// =====================================================================
'use strict';

const axios = require('axios');
const crypto = require('crypto');
const db = require('../db');
const eventDispatcher = require('../services/eventDispatcher');

const BSP_PAY_BASE_URL = process.env.BSP_PAY_BASE_URL || 'https://api.bsp.com.pg/pay';
const BSP_PAY_MERCHANT_ID = process.env.BSP_PAY_MERCHANT_ID;
const BSP_PAY_SECRET = process.env.BSP_PAY_SECRET;

const KINA_IPG_BASE_URL = process.env.KINA_IPG_BASE_URL || 'https://ipg.kinabank.com.pg';
const KINA_IPG_MERCHANT_ID = process.env.KINA_IPG_MERCHANT_ID;
const KINA_IPG_TOKEN = process.env.KINA_IPG_TOKEN;
const KINA_IPG_WEBHOOK_SECRET = process.env.KINA_IPG_WEBHOOK_SECRET;

const bspClient = axios.create({
  baseURL: BSP_PAY_BASE_URL,
  timeout: 10000,
  headers: { Authorization: `Bearer ${BSP_PAY_SECRET}`, Accept: 'application/json' },
});

const kinaClient = axios.create({
  baseURL: KINA_IPG_BASE_URL,
  timeout: 10000,
  headers: { Authorization: `Bearer ${KINA_IPG_TOKEN}`, Accept: 'application/json' },
});

/**
 * POST /banking/bsp/checkout
 * Initiate a direct checkout pipeline using the customer's bank customer
 * number via the BSP Pay merchant REST API workflow.
 */
async function initiateBSPPayCheck(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId || req.body.branchId || null;
  const { bankCustomerNumber, amount, currency = 'PGK', description } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!bankCustomerNumber || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'bankCustomerNumber and a positive amount are required.' });
  }

  try {
    const checkoutResp = await bspClient.post('/v1/checkout', {
      merchant_id: BSP_PAY_MERCHANT_ID,
      customer_number: bankCustomerNumber,
      amount,
      currency,
      description: description || 'Deeps Systems AIO checkout',
      callback_url: process.env.BSP_PAY_CALLBACK_URL,
    });

    const gatewayReferenceId = checkoutResp.data && checkoutResp.data.reference_id;

    const txResult = await db.query(
      `INSERT INTO financial_transactions
          (tenant_id, branch_id, transaction_type, amount, currency, description,
           is_manual, verification_status, payment_gateway, gateway_reference_id)
       VALUES ($1, $2, 'INCOME', $3, $4, $5, FALSE, 'PENDING', 'BSP_PAY', $6)
       RETURNING *`,
      [tenantId, branchId, amount, currency, description || null, gatewayReferenceId || null]
    );

    return res.status(202).json({
      status: 'checkout_initiated',
      transaction: txResult.rows[0],
      gatewayResponse: checkoutResp.data,
    });
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('[bankingController] initiateBSPPayCheck failed', detail);
    return res.status(502).json({ error: 'BSP Pay checkout initiation failed.', detail });
  }
}

/**
 * POST /banking/kina/webhook
 * Handle secure asynchronous IPG webhook callbacks from Kina Bank for
 * Visa/Mastercard card network transactions.
 */
async function handleKinaIPGWebhook(req, res) {
  const tenantId = req.tenantId;

  // Verify the webhook signature before trusting the payload.
  const signature = req.headers['x-kina-signature'];
  if (KINA_IPG_WEBHOOK_SECRET) {
    const computed = crypto
      .createHmac('sha256', KINA_IPG_WEBHOOK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed))) {
      console.warn('[bankingController] Kina IPG webhook signature mismatch — rejecting.');
      return res.status(401).json({ error: 'Invalid webhook signature.' });
    }
  } else {
    console.warn('[bankingController] KINA_IPG_WEBHOOK_SECRET not configured — skipping signature check.');
  }

  const { referenceId, status, amount, cardNetwork } = req.body || {};

  if (!referenceId) {
    return res.status(400).json({ error: 'referenceId is required in webhook payload.' });
  }

  try {
    const lookupResult = await db.query(
      `SELECT * FROM financial_transactions
        WHERE tenant_id = $1 AND gateway_reference_id = $2
        LIMIT 1`,
      [tenantId, referenceId]
    );

    if (lookupResult.rowCount === 0) {
      console.warn(`[bankingController] Kina webhook for unknown reference ${referenceId}`);
      return res.sendStatus(200); // ack anyway to prevent retry storms
    }

    const existing = lookupResult.rows[0];
    const newStatus = status === 'SUCCESS' ? 'VERIFIED' : status === 'FAILED' ? 'FAILED' : 'PENDING';

    const updateResult = await db.query(
      `UPDATE financial_transactions SET verification_status = $1 WHERE id = $2 RETURNING *`,
      [newStatus, existing.id]
    );

    const transaction = updateResult.rows[0];

    eventDispatcher.dispatchAsync('transaction.kina_ipg.updated', tenantId, {
      transaction,
      cardNetwork,
      reportedAmount: amount,
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error('[bankingController] handleKinaIPGWebhook failed', err);
    return res.status(500).json({ error: 'Failed to process Kina IPG webhook.' });
  }
}

/**
 * POST /banking/manual/reconcile
 * Review gate: an admin/manager marks a manually-entered cash/bank
 * transfer transaction as VERIFIED or FAILED after checking bank records.
 */
async function reconcileManualTransfer(req, res) {
  const tenantId = req.tenantId;
  const { transactionId, decision, reviewerNotes } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!transactionId || !['VERIFIED', 'FAILED'].includes(decision)) {
    return res.status(400).json({ error: 'transactionId and decision (VERIFIED|FAILED) are required.' });
  }

  try {
    const lookupResult = await db.query(
      `SELECT * FROM financial_transactions
        WHERE id = $1 AND tenant_id = $2 AND is_manual = TRUE
        LIMIT 1`,
      [transactionId, tenantId]
    );

    if (lookupResult.rowCount === 0) {
      return res.status(404).json({ error: 'Manual transaction not found for this tenant.' });
    }

    const updateResult = await db.query(
      `UPDATE financial_transactions
          SET verification_status = $1,
              description = COALESCE(description, '') || CASE WHEN $2::text IS NOT NULL THEN E'\n[Review] ' || $2 ELSE '' END
        WHERE id = $3
        RETURNING *`,
      [decision, reviewerNotes || null, transactionId]
    );

    const transaction = updateResult.rows[0];

    eventDispatcher.dispatchAsync('transaction.manual.reviewed', tenantId, {
      transaction,
      reviewedBy: (req.authUser && req.authUser.userId) || null,
    });

    return res.status(200).json(transaction);
  } catch (err) {
    console.error('[bankingController] reconcileManualTransfer failed', err);
    return res.status(500).json({ error: 'Failed to reconcile manual transfer.' });
  }
}

module.exports = {
  initiateBSPPayCheck,
  handleKinaIPGWebhook,
  reconcileManualTransfer,
};
