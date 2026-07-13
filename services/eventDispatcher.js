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
