// =====================================================================
// services/eventDispatcher.js
// Lightweight event-driven dispatcher: fires structured events out to
// external automation/AI microservices (AI_ENGINE_SERVICE_URL and any
// registered subscriber URLs) without blocking the calling request.
// =====================================================================
'use strict';

const axios = require('axios');
const { EventEmitter } = require('events');

class EventDispatcher extends EventEmitter {
  constructor() {
    super();

    this.aiEngineUrl = process.env.AI_ENGINE_SERVICE_URL || null;

    // Additional static subscriber endpoints can be provided as a comma
    // separated list, e.g. WEBHOOK_SUBSCRIBERS="https://a.example/hook,https://b.example/hook"
    this.staticSubscribers = (process.env.WEBHOOK_SUBSCRIBERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    this.httpClient = axios.create({ timeout: 6000 });

    // Local in-process listeners (e.g. logging, metrics) don't need HTTP.
    this.on('dispatch:error', (err) => {
      console.error('[eventDispatcher] delivery error', err.message);
    });

    // In-process cross-module triggers
    this.on('sales.lead_won', async (tenantId, payload) => {
      if (typeof tenantId === 'object' && tenantId.tenantId) {
        payload = tenantId.payload;
        tenantId = tenantId.tenantId;
      }
      const db = require('../db');
      try {
        const { lead } = payload || {};
        if (!lead) return;

        // 1. Store client entry (contacts table)
        const contactResult = await db.query(
          `INSERT INTO contacts (tenant_id, first_name, last_name, email)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [
            tenantId,
            lead.full_name ? lead.full_name.split(' ')[0] : 'Store',
            lead.full_name ? lead.full_name.split(' ').slice(1).join(' ') : 'Client',
            lead.email || 'customer@store.com'
          ]
        );
        const contactId = contactResult.rows[0].id;

        // Link contact to lead
        await db.query(
          `UPDATE sales_leads SET contact_id = $1 WHERE id = $2`,
          [contactId, lead.id]
        );

        // 2. Workspace follow-up assignment (workspace_tasks table)
        await db.query(
          `INSERT INTO workspace_tasks (tenant_id, title, description, lead_id, source_module, source_record_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenantId, `Follow up with ${lead.full_name || 'Won Lead'}`, `Configure onboarding and deployment for won lead`, lead.id, 'sales', lead.id]
        );
        console.log(`[eventDispatcher] [Reaction] sales.lead_won handled for lead ${lead.id}`);
      } catch (err) {
        console.error('[eventDispatcher] sales.lead_won reaction error:', err);
      }
    });

    this.on('store.checkout_completed', async (tenantId, payload) => {
      if (typeof tenantId === 'object' && tenantId.tenantId) {
        payload = tenantId.payload;
        tenantId = tenantId.tenantId;
      }
      const db = require('../db');
      try {
        const { checkout } = payload || {};
        if (!checkout) return;

        // 1. Provision a Logistics delivery record
        await db.query(
          `INSERT INTO logistics_shipments (tenant_id, carrier_name, shipping_status, source_module, source_record_id, destination_address)
           VALUES ($1, 'DHL', 'PENDING', 'store', $2, $3)`,
          [tenantId, checkout.id, `Deliver to ${checkout.email || 'customer@store.com'}`]
        );

        // 2. Log a Finance incoming ledger entry
        await db.query(
          `INSERT INTO financial_transactions
              (tenant_id, transaction_type, amount, currency, description, is_manual, verification_status, payment_gateway, source_module, source_record_id)
           VALUES ($1, 'INCOME', $2, $3, $4, TRUE, 'VERIFIED', 'BSP_PAY', 'store', $5)`,
          [tenantId, checkout.amount, checkout.currency || 'PGK', `Store checkout completed for ${checkout.email || 'customer@store.com'}`, checkout.id]
        );
        console.log(`[eventDispatcher] [Reaction] store.checkout_completed handled for checkout ${checkout.id}`);
      } catch (err) {
        console.error('[eventDispatcher] store.checkout_completed reaction error:', err);
      }
    });

    this.on('fees.invoice_cleared', async (tenantId, payload) => {
      if (typeof tenantId === 'object' && tenantId.tenantId) {
        payload = tenantId.payload;
        tenantId = tenantId.tenantId;
      }
      const db = require('../db');
      try {
        const { fee } = payload || {};
        if (!fee) return;

        // Populate a Finance collection transaction
        await db.query(
          `INSERT INTO financial_transactions
              (tenant_id, transaction_type, amount, currency, description, is_manual, verification_status, payment_gateway, source_module, source_record_id)
           VALUES ($1, 'INCOME', $2, $3, $4, TRUE, 'VERIFIED', 'BSP_PAY', 'fees', $5)`,
          [tenantId, fee.amount, fee.currency || 'PGK', `Administrative fee cleared: ${fee.fee_name}`, fee.id]
        );
        console.log(`[eventDispatcher] [Reaction] fees.invoice_cleared handled for fee ${fee.id}`);
      } catch (err) {
        console.error('[eventDispatcher] fees.invoice_cleared reaction error:', err);
      }
    });
  }

  /**
   * Dispatch a structured event. Resolves immediately after fire-and-forget
   * delivery attempts are scheduled — callers should NOT await this if they
   * want a truly non-blocking UI thread; awaiting only guarantees the
   * dispatch attempts were *initiated*, not that they succeeded.
   *
   * @param {string} eventName e.g. 'transaction.created', 'shipment.status_updated'
   * @param {string} tenantId
   * @param {object} payload
   */
  async dispatch(eventName, tenantId, payload = {}) {
    // Emit locally for in-process reactive triggers
    try {
      this.emit(eventName, tenantId, payload);
    } catch (localErr) {
      console.error(`[eventDispatcher] local handler failed for event "${eventName}":`, localErr);
    }

    const envelope = {
      event: eventName,
      tenantId,
      payload,
      dispatchedAt: new Date().toISOString(),
    };

    const targets = [];
    if (this.aiEngineUrl) targets.push(this.aiEngineUrl);
    targets.push(...this.staticSubscribers);

    if (targets.length === 0) {
      console.warn(
        `[eventDispatcher] no subscribers configured; dropping event "${eventName}" for tenant ${tenantId}`
      );
      return { delivered: 0, attempted: 0 };
    }

    const deliveries = targets.map((url) =>
      this.httpClient
        .post(url, envelope)
        .then(() => ({ url, ok: true }))
        .catch((err) => {
          this.emit('dispatch:error', err);
          return { url, ok: false, error: err.message };
        })
    );

    // We deliberately do not await sequentially — deliver concurrently and
    // let the caller decide whether to await the aggregate settlement.
    const results = await Promise.allSettled(deliveries);
    const delivered = results.filter(
      (r) => r.status === 'fulfilled' && r.value.ok
    ).length;

    return { delivered, attempted: targets.length, results };
  }

  /**
   * Fire-and-forget variant for hot paths where the caller must not wait
   * on network I/O at all (e.g. inside a webhook handler that needs to
   * return 200 to Meta/DHL/Kina within a tight SLA).
   */
  dispatchAsync(eventName, tenantId, payload = {}) {
    setImmediate(() => {
      this.dispatch(eventName, tenantId, payload).catch((err) => {
        console.error('[eventDispatcher] dispatchAsync failed', err);
      });
    });
  }
}

// Singleton instance shared across the app.
module.exports = new EventDispatcher();
