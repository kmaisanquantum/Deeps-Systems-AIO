// =====================================================================
// services/akauntingService.js
// Axios adapter for the self-hosted Akaunting container, reachable over
// the internal Coolify/Docker bridge network at http://akaunting:80
// =====================================================================
'use strict';

const axios = require('axios');

const AKAUNTING_BASE_URL = process.env.AKAUNTING_BASE_URL || 'http://akaunting:80';
const AKAUNTING_API_KEY = process.env.AKAUNTING_API_KEY;
// Akaunting is itself multi-company; map our tenant to an Akaunting
// company id via env or a per-tenant lookup if you outgrow a single company.
const AKAUNTING_COMPANY_ID = process.env.AKAUNTING_COMPANY_ID || '1';

const client = axios.create({
  baseURL: AKAUNTING_BASE_URL,
  timeout: 8000,
  headers: {
    Authorization: `Bearer ${AKAUNTING_API_KEY}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

/**
 * Wrap Akaunting/network failures into a consistent shape so callers
 * (controllers) don't need to know about Axios internals, and so a
 * dropped Docker-network connection doesn't crash the request thread.
 */
function normalizeError(err, context) {
  if (err.response) {
    return new Error(
      `[akauntingService] ${context} failed: HTTP ${err.response.status} — ${JSON.stringify(
        err.response.data
      )}`
    );
  }
  if (err.request) {
    return new Error(
      `[akauntingService] ${context} failed: no response from Akaunting container (network/docker bridge issue) — ${err.message}`
    );
  }
  return new Error(`[akauntingService] ${context} failed: ${err.message}`);
}

/**
 * Look up a customer (a.k.a. "contact" of type customer) by email; create
 * one if it doesn't already exist. Returns the Akaunting customer id.
 */
async function getOrCreateCustomer(name, email) {
  if (!name || !email) {
    throw new Error('[akauntingService] getOrCreateCustomer requires both name and email.');
  }

  try {
    const searchResp = await client.get('/api/customers', {
      params: { 'search': `email:${email}`, company_id: AKAUNTING_COMPANY_ID },
    });

    const existing = searchResp.data && searchResp.data.data && searchResp.data.data[0];
    if (existing) {
      return existing.id;
    }
  } catch (err) {
    // If the search itself fails we still attempt creation below rather
    // than hard-failing — Akaunting's search endpoint can be flaky on
    // sparse datasets. Log for visibility.
    console.warn('[akauntingService] customer search failed, proceeding to create', err.message);
  }

  try {
    const createResp = await client.post('/api/customers', {
      company_id: AKAUNTING_COMPANY_ID,
      name,
      email,
      currency_code: 'PGK',
      enabled: true,
    });

    const created = createResp.data && createResp.data.data;
    if (!created || !created.id) {
      throw new Error('Akaunting returned no customer id on creation.');
    }
    return created.id;
  } catch (err) {
    throw normalizeError(err, 'getOrCreateCustomer');
  }
}

/**
 * Create an invoice for a given customer.
 * @param {string|number} customerId
 * @param {Array<{name: string, quantity: number, price: number}>} itemDetails
 * @param {number} cost - total invoice amount (used as a sanity cross-check)
 */
async function createInvoice(customerId, itemDetails, cost) {
  if (!customerId) throw new Error('[akauntingService] createInvoice requires customerId.');
  if (!Array.isArray(itemDetails) || itemDetails.length === 0) {
    throw new Error('[akauntingService] createInvoice requires at least one line item.');
  }

  const issuedAt = new Date().toISOString().slice(0, 10);
  const dueAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const lineItems = itemDetails.map((item) => ({
    name: item.name,
    quantity: item.quantity || 1,
    price: item.price,
  }));

  const computedTotal = lineItems.reduce((sum, i) => sum + i.quantity * i.price, 0);
  if (typeof cost === 'number' && Math.abs(computedTotal - cost) > 0.01) {
    console.warn(
      `[akauntingService] createInvoice: provided cost (${cost}) does not match summed line items (${computedTotal}); proceeding with line items as source of truth.`
    );
  }

  try {
    const resp = await client.post('/api/invoices', {
      company_id: AKAUNTING_COMPANY_ID,
      contact_id: customerId,
      issued_at: issuedAt,
      due_at: dueAt,
      currency_code: 'PGK',
      items: lineItems,
      status: 'draft',
    });

    const invoice = resp.data && resp.data.data;
    if (!invoice || !invoice.id) {
      throw new Error('Akaunting returned no invoice id on creation.');
    }
    return invoice;
  } catch (err) {
    throw normalizeError(err, 'createInvoice');
  }
}

/**
 * Mark an existing invoice as paid / record a payment transaction against
 * it — used by the webhook reconciliation flow.
 */
async function recordInvoicePayment(invoiceId, amount, paymentMethod = 'other') {
  if (!invoiceId) throw new Error('[akauntingService] recordInvoicePayment requires invoiceId.');

  try {
    const resp = await client.post(`/api/invoices/${invoiceId}/payments`, {
      company_id: AKAUNTING_COMPANY_ID,
      amount,
      paid_at: new Date().toISOString().slice(0, 10),
      payment_method: paymentMethod,
    });
    return resp.data && resp.data.data;
  } catch (err) {
    throw normalizeError(err, 'recordInvoicePayment');
  }
}

/**
 * Fetch a single invoice by id — used to confirm state during reconciliation.
 */
async function getInvoice(invoiceId) {
  try {
    const resp = await client.get(`/api/invoices/${invoiceId}`, {
      params: { company_id: AKAUNTING_COMPANY_ID },
    });
    return resp.data && resp.data.data;
  } catch (err) {
    throw normalizeError(err, 'getInvoice');
  }
}

module.exports = {
  getOrCreateCustomer,
  createInvoice,
  recordInvoicePayment,
  getInvoice,
};
