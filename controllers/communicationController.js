// =====================================================================
// controllers/communicationController.js
// Inbound webhook receivers + outbound dispatch across WhatsApp, Email
// (HostGator SMTP), and SMS.
// =====================================================================
'use strict';

const nodemailer = require('nodemailer');
const axios = require('axios');
const db = require('../db');
const eventDispatcher = require('../services/eventDispatcher');

const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v19.0';

const SMS_API_URL = process.env.SMS_API_URL;
const SMS_API_KEY = process.env.SMS_API_KEY;

const mailTransport = nodemailer.createTransport({
  host: process.env.HOSTGATOR_SMTP_HOST,
  port: parseInt(process.env.HOSTGATOR_SMTP_PORT || '465', 10),
  secure: (process.env.HOSTGATOR_SMTP_SECURE || 'true') === 'true',
  auth: {
    user: process.env.HOSTGATOR_SMTP_USER,
    pass: process.env.HOSTGATOR_SMTP_PASS,
  },
});

/**
 * GET /webhooks/whatsapp — Meta's handshake verification.
 */
function verifyWhatsAppWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

/**
 * POST /webhooks/whatsapp — inbound message ingestion.
 * Meta requires a fast 200 response; heavy processing (AI intent parsing,
 * downstream side effects) is dispatched asynchronously.
 */
async function handleWhatsAppWebhook(req, res) {
  try {
    const entry = req.body && req.body.entry && req.body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const message = value && value.messages && value.messages[0];

    if (!message) {
      // Status callbacks (delivered/read receipts) land here too — ack and exit.
      return res.sendStatus(200);
    }

    const fromNumber = message.from;
    const textBody =
      (message.text && message.text.body) ||
      (message.button && message.button.text) ||
      '[unsupported message type]';

    // tenantId is resolved upstream by tenantResolver based on subdomain
    // routing, or, for a shared webhook URL, may need to be resolved here
    // via a phone-number-id -> tenant mapping table. We assume req.tenantId
    // is already populated by the routing layer for simplicity.
    const tenantId = req.tenantId;

    const insertResult = await db.query(
      `INSERT INTO communication_logs
          (tenant_id, channel, direction, sender_ref, recipient_ref, raw_payload, status)
       VALUES ($1, 'WHATSAPP', 'INBOUND', $2, $3, $4, 'RECEIVED')
       RETURNING id`,
      [tenantId, fromNumber, WHATSAPP_PHONE_NUMBER_ID, JSON.stringify(req.body)]
    );

    const logId = insertResult.rows[0].id;

    // Hand off to the AI intent engine asynchronously — do not block the
    // webhook response on it.
    eventDispatcher.dispatchAsync('communication.whatsapp.received', tenantId, {
      communicationLogId: logId,
      fromNumber,
      textBody,
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error('[communicationController] handleWhatsAppWebhook failed', err);
    // Still return 200 to avoid Meta retry storms on a transient internal
    // error — the failure is logged for manual/automated follow-up.
    return res.sendStatus(200);
  }
}

/**
 * POST /webhooks/email-inbound — receiver for a processed inbound-mail
 * pipeline (e.g. an IMAP polling worker or a mail-parsing webhook
 * forwarder) delivering normalized payloads for financial receipts.
 */
async function handleInboundEmailHook(req, res) {
  try {
    const { fromAddress, subject, bodyText, attachments } = req.body || {};
    const tenantId = req.tenantId;

    if (!fromAddress) {
      return res.status(400).json({ error: 'fromAddress is required.' });
    }

    const insertResult = await db.query(
      `INSERT INTO communication_logs
          (tenant_id, channel, direction, sender_ref, raw_payload, status)
       VALUES ($1, 'EMAIL', 'INBOUND', $2, $3, 'RECEIVED')
       RETURNING id`,
      [tenantId, fromAddress, JSON.stringify({ subject, bodyText, attachments: (attachments || []).map(a => a.filename) })]
    );

    const logId = insertResult.rows[0].id;

    eventDispatcher.dispatchAsync('communication.email.received', tenantId, {
      communicationLogId: logId,
      fromAddress,
      subject,
      bodyText,
      hasAttachments: Array.isArray(attachments) && attachments.length > 0,
    });

    return res.status(202).json({ status: 'queued', communicationLogId: logId });
  } catch (err) {
    console.error('[communicationController] handleInboundEmailHook failed', err);
    return res.status(500).json({ error: 'Failed to process inbound email payload.' });
  }
}

/**
 * Centralized outbound dispatch across channels.
 * POST /communications/dispatch
 * body: { channel: 'WHATSAPP'|'EMAIL'|'SMS', to, subject?, message }
 */
async function dispatchOutboundMessage(req, res) {
  const { channel, to, subject, message } = req.body || {};
  const tenantId = req.tenantId;

  if (!channel || !to || !message) {
    return res.status(400).json({ error: 'channel, to, and message are required.' });
  }

  try {
    let providerResponse;

    switch (channel) {
      case 'WHATSAPP':
        providerResponse = await sendWhatsAppMessage(to, message);
        break;
      case 'EMAIL':
        providerResponse = await sendEmailMessage(to, subject || 'Notification', message);
        break;
      case 'SMS':
        providerResponse = await sendSmsMessage(to, message);
        break;
      default:
        return res.status(400).json({ error: `Unsupported channel "${channel}".` });
    }

    await db.query(
      `INSERT INTO communication_logs
          (tenant_id, channel, direction, recipient_ref, raw_payload, status)
       VALUES ($1, $2, 'OUTBOUND', $3, $4, 'SENT')`,
      [tenantId, channel, to, JSON.stringify({ message, subject, providerResponse })]
    );

    return res.status(200).json({ status: 'sent' });
  } catch (err) {
    console.error(`[communicationController] dispatchOutboundMessage (${channel}) failed`, err);

    await db.query(
      `INSERT INTO communication_logs
          (tenant_id, channel, direction, recipient_ref, raw_payload, status)
       VALUES ($1, $2, 'OUTBOUND', $3, $4, 'FAILED')`,
      [tenantId, channel, to, JSON.stringify({ message, subject, error: err.message })]
    );

    return res.status(502).json({ error: 'Failed to dispatch message.', detail: err.message });
  }
}

async function sendWhatsAppMessage(toNumber, message) {
  const url = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const resp = await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'text',
      text: { body: message },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_API_TOKEN}` }, timeout: 8000 }
  );
  return resp.data;
}

async function sendEmailMessage(toAddress, subject, message) {
  return mailTransport.sendMail({
    from: process.env.HOSTGATOR_SMTP_FROM || process.env.HOSTGATOR_SMTP_USER,
    to: toAddress,
    subject,
    text: message,
  });
}

async function sendSmsMessage(toNumber, message) {
  if (!SMS_API_URL) {
    throw new Error('SMS_API_URL is not configured.');
  }
  const resp = await axios.post(
    SMS_API_URL,
    { to: toNumber, message },
    { headers: { Authorization: `Bearer ${SMS_API_KEY}` }, timeout: 8000 }
  );
  return resp.data;
}

module.exports = {
  verifyWhatsAppWebhook,
  handleWhatsAppWebhook,
  handleInboundEmailHook,
  dispatchOutboundMessage,
};
