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

    // Capturing Response Helper to wrap simulated Express HTTP requests in listeners
    function createCapturingResponse() {
      const capture = { statusCode: 200, body: null };
      return {
        capture,
        status(code) {
          capture.statusCode = code;
          return this;
        },
        json(payload) {
          capture.body = payload;
          return this;
        },
        sendStatus(code) {
          capture.statusCode = code;
          capture.body = null;
          return this;
        }
      };
    }

    // In-process cross-module triggers
    this.on('sales.lead_won', async (tenantId, payload) => {
      if (typeof tenantId === 'object' && tenantId.tenantId) {
        payload = tenantId.payload;
        tenantId = tenantId.tenantId;
      }
      const db = require('../db');
      const workspaceController = require('../controllers/workspaceController');
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

        // 2. Workspace follow-up assignment (workspace_tasks table) using workspaceController.createTask
        const fakeReq = {
          tenantId,
          body: {
            title: `Follow up with ${lead.full_name || 'Won Lead'}`,
            description: `Configure onboarding and deployment for won lead`,
            status: 'TODO',
            priority: 'NORMAL'
          }
        };
        const fakeRes = createCapturingResponse();
        await workspaceController.createTask(fakeReq, fakeRes);

        const createdTask = fakeRes.capture.body;
        if (createdTask && createdTask.id) {
          await db.query(
            `UPDATE workspace_tasks
                SET lead_id = $1, source_module = 'sales', source_record_id = $2
              WHERE id = $3 AND tenant_id = $4`,
            [lead.id, lead.id, createdTask.id, tenantId]
          );
        }
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
      const financeController = require('../controllers/financeController');
      try {
        const { checkout } = payload || {};
        if (!checkout) return;

        // 1. Provision a Logistics delivery record
        await db.query(
          `INSERT INTO logistics_shipments (tenant_id, carrier_name, shipping_status, source_module, source_record_id, destination_address)
           VALUES ($1, 'DHL', 'PENDING', 'store', $2, $3)`,
          [tenantId, checkout.id, `Deliver to ${checkout.email || 'customer@store.com'}`]
        );

        // 2. Log a Finance incoming ledger entry using financeController.logTransaction
        const fakeReq = {
          tenantId,
          body: {
            transactionType: 'INCOME',
            amount: checkout.amount,
            currency: checkout.currency || 'PGK',
            description: `Store checkout completed for ${checkout.email || 'customer@store.com'}`,
            paymentGateway: 'BSP_PAY'
          }
        };
        const fakeRes = createCapturingResponse();
        await financeController.logTransaction(fakeReq, fakeRes);

        const createdTx = fakeRes.capture.body;
        if (createdTx && createdTx.id) {
          await db.query(
            `UPDATE financial_transactions
                SET source_module = 'store', source_record_id = $1
              WHERE id = $2 AND tenant_id = $3`,
            [checkout.id, createdTx.id, tenantId]
          );
        }
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
      const financeController = require('../controllers/financeController');
      try {
        const { fee } = payload || {};
        if (!fee) return;

        // Log a Finance collection transaction using financeController.logTransaction
        const fakeReq = {
          tenantId,
          body: {
            transactionType: 'INCOME',
            amount: fee.amount,
            currency: fee.currency || 'PGK',
            description: `Administrative fee cleared: ${fee.fee_name}`,
            paymentGateway: 'BSP_PAY'
          }
        };
        const fakeRes = createCapturingResponse();
        await financeController.logTransaction(fakeReq, fakeRes);

        const createdTx = fakeRes.capture.body;
        if (createdTx && createdTx.id) {
          await db.query(
            `UPDATE financial_transactions
                SET source_module = 'fees', source_record_id = $1
              WHERE id = $2 AND tenant_id = $3`,
            [fee.id, createdTx.id, tenantId]
          );
        }
        console.log(`[eventDispatcher] [Reaction] fees.invoice_cleared handled for fee ${fee.id}`);
      } catch (err) {
        console.error('[eventDispatcher] fees.invoice_cleared reaction error:', err);
      }
    });

    this.on('autonomous.alert', async (tenantId, payload) => {
      if (typeof tenantId === 'object' && tenantId.tenantId) {
        payload = tenantId.payload;
        tenantId = tenantId.tenantId;
      }
      const { type, detail } = payload || {};
      console.log(`[autonomous.alert] [LOG] Tenant "${tenantId}" issued autonomous alert type "${type}": ${detail}`);

      const alertChannel = (process.env.ALERT_CHANNEL || '').toLowerCase().trim();
      const alertRecipient = process.env.ALERT_RECIPIENT || '67579452732';

      if (!alertChannel) {
        return;
      }

      const subject = `Deeps AIO Autonomous Alert: ${type}`;
      const message = `Autonomous alert of type "${type}" has been raised.
Detail: ${detail}
Impacted Tenant ID: ${tenantId}
System Timestamp: ${new Date().toISOString()}`;

      try {
        if (alertChannel === 'whatsapp') {
          if (!alertRecipient) {
            console.warn('[autonomous.alert] Alert recipient not specified for WhatsApp channel.');
            return;
          }

          // Circular require prevention: Lazily load communication dependency
          const commsController = require('../controllers/communicationController');
          const whatsappMsg = `Deeps Systems Alert [${type}]: ${detail}`;

          let status = 'SENT';
          try {
            await commsController.sendWhatsAppMessage(alertRecipient, whatsappMsg);
            console.log(`[autonomous.alert] Direct WhatsApp alert dispatched to: ${alertRecipient}`);
          } catch (apiErr) {
            status = 'FAILED';
            console.error('[autonomous.alert] Direct WhatsApp alert delivery failed:', apiErr.message);
          }

          // DB Audit Trail Logging
          const db = require('../db');
          try {
            await db.query(
              `INSERT INTO communication_logs (tenant_id, channel, direction, recipient, status, subject, message)
               VALUES ($1, 'WHATSAPP', 'OUTBOUND', $2, $3, $4, $5)`,
              [tenantId, alertRecipient, status, `WhatsApp Alert: ${type}`, whatsappMsg]
            );
          } catch (dbErr) {
            console.error('[autonomous.alert] failed to persist communication log:', dbErr.message);
          }

          if (status === 'FAILED') {
            throw new Error('API delivery failed');
          }
        } else {
          // Fallback other channel delivery routines (EMAIL, SMS, WEBHOOK)
          const legacyChannel = alertChannel.toUpperCase();
          if (['EMAIL', 'SMS'].includes(legacyChannel)) {
            const communicationController = require('../controllers/communicationController');
            const fakeReq = {
              tenantId,
              authUser: { userId: 'system-monitor', role: 'superadmin' },
              body: {
                channel: legacyChannel,
                to: alertRecipient,
                subject,
                message
              }
            };
            const fakeRes = createCapturingResponse();
            await communicationController.dispatchOutboundMessage(fakeReq, fakeRes);
            console.log(`[autonomous.alert] Dispatched outbound alert through channel "${legacyChannel}". HTTP Status: ${fakeRes.capture.statusCode}`);
          } else if (legacyChannel === 'WEBHOOK') {
            await this.httpClient.post(alertRecipient, {
              event: 'autonomous.alert',
              tenantId,
              type,
              detail,
              at: new Date().toISOString()
            });
            console.log(`[autonomous.alert] Dispatched alert webhook to: ${alertRecipient}`);
          }
        }
      } catch (err) {
        console.error(`[autonomous.alert] delivery failed: ${err.message}`);
      }
    });

    this.on('logistics.status_updated', async (tenantId, payload) => {
      if (typeof tenantId === 'object' && tenantId.tenantId) {
        payload = tenantId.payload;
        tenantId = tenantId.tenantId;
      }
      const db = require('../db');
      const communicationController = require('../controllers/communicationController');
      try {
        const { shipment } = payload || {};
        if (!shipment) return;

        // Find recipient contact details
        let email = null;
        const emailMatch = (shipment.destination_address || '').match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/);
        if (emailMatch) {
          email = emailMatch[1];
        }

        if (!email && shipment.source_module === 'store' && shipment.source_record_id) {
          const coResult = await db.query(
            'SELECT email FROM store_checkouts WHERE id = $1 AND tenant_id = $2',
            [shipment.source_record_id, tenantId]
          );
          if (coResult.rowCount > 0) {
            email = coResult.rows[0].email;
          }
        }

        if (!email) {
          const cResult = await db.query(
            'SELECT email FROM contacts WHERE tenant_id = $1 LIMIT 1',
            [tenantId]
          );
          if (cResult.rowCount > 0) {
            email = cResult.rows[0].email;
          }
        }

        const targetEmail = email || 'customer@store.com';

        // Send a Communications notification to the shipment's destination contact via communicationController
        const fakeReq = {
          tenantId,
          body: {
            channel: 'EMAIL',
            to: targetEmail,
            subject: `Shipment Status Updated: ${shipment.shipping_status}`,
            message: `Your shipment (tracking: ${shipment.tracking_number || 'Pending'}) status is now: ${shipment.shipping_status}. Destination: ${shipment.destination_address || 'N/A'}`
          }
        };
        const fakeRes = createCapturingResponse();
        await communicationController.dispatchOutboundMessage(fakeReq, fakeRes);
        console.log(`[eventDispatcher] [Reaction] logistics.status_updated processed. Recipient: ${targetEmail}, Status: ${fakeRes.capture.statusCode}`);
      } catch (err) {
        console.error('[eventDispatcher] logistics.status_updated reaction error:', err);
      }
    });

    this.on('learning.schedule_created', async (tenantId, payload) => {
      if (typeof tenantId === 'object' && tenantId.tenantId) {
        payload = tenantId.payload;
        tenantId = tenantId.tenantId;
      }
      const feesController = require('../controllers/feesController');
      try {
        const { schedule, studentUserId } = payload || {};
        if (!schedule) return;

        // Auto-create a Fees invoice (recurring operating expenses/service fee) using feesController.createFee
        const fakeReq = {
          tenantId,
          body: {
            feeName: `Tuition Fee: ${schedule.title}`,
            provider: 'Academy Pathway',
            category: 'OTHER',
            amount: 150.00,
            currency: 'PGK',
            billingCycle: 'ONE_OFF',
            status: 'ACTIVE',
            notes: `Auto-generated tuition invoice for study schedule ID ${schedule.id}. Student: ${studentUserId || 'N/A'}`
          }
        };
        const fakeRes = createCapturingResponse();
        await feesController.createFee(fakeReq, fakeRes);
        console.log(`[eventDispatcher] [Reaction] learning.schedule_created handled and created fee:`, fakeRes.capture.body);
      } catch (err) {
        console.error('[eventDispatcher] learning.schedule_created reaction error:', err);
      }
    });

    this.on('hr.payroll_run', async (tenantId, payload) => {
      if (typeof tenantId === 'object' && tenantId.tenantId) {
        payload = tenantId.payload;
        tenantId = tenantId.tenantId;
      }
      const db = require('../db');
      const financeController = require('../controllers/financeController');
      try {
        const { profile } = payload || {};
        if (!profile) return;

        // Log a Finance EXPENSE ledger entry using financeController.logTransaction
        const fakeReq = {
          tenantId,
          body: {
            transactionType: 'EXPENSE',
            amount: Number(profile.salary_amount || 0.00),
            currency: profile.salary_currency || 'PGK',
            description: `Payroll run salary payment for ${profile.full_name || 'Employee'}`,
            paymentGateway: 'INTERNAL_BRIDGE'
          }
        };
        const fakeRes = createCapturingResponse();
        await financeController.logTransaction(fakeReq, fakeRes);

        const createdTx = fakeRes.capture.body;
        if (createdTx && createdTx.id) {
          await db.query(
            `UPDATE financial_transactions
                SET source_module = 'hr', source_record_id = $1
              WHERE id = $2 AND tenant_id = $3`,
            [profile.id, createdTx.id, tenantId]
          );
        }
        console.log(`[eventDispatcher] [Reaction] hr.payroll_run handled for profile ${profile.id}`);
      } catch (err) {
        console.error('[eventDispatcher] hr.payroll_run reaction error:', err);
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
