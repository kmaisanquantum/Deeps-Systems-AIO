// =====================================================================
// controllers/intentController.js
// "Talk-to-Options" — takes free-form natural language (text or audio
// transcription) and routes it through the external AI orchestration
// engine, then maps the structured result onto internal controllers.
// =====================================================================
'use strict';

const axios = require('axios');
const db = require('../db');
const financeController = require('./financeController');
const logisticsService = require('../services/logisticsService');
const hrController = require('./hrController');
const eventDispatcher = require('../services/eventDispatcher');

const salesController = require('./salesController');
const storeController = require('./storeController');
const workspaceController = require('./workspaceController');

const AI_ENGINE_SERVICE_URL = process.env.AI_ENGINE_SERVICE_URL;

const aiClient = axios.create({
  baseURL: AI_ENGINE_SERVICE_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * A minimal mock-response wrapper that lets controller functions be
 * invoked programmatically (rather than through Express routing) and
 * have their JSON payload captured for the intent response, instead of
 * being written directly to an HTTP socket.
 */
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
    },
  };
}

/**
 * POST /intent/process
 * body: { text: string, sourceChannel?: 'WHATSAPP'|'VOICE_MEMO'|'INTERNAL' }
 *
 * Packages the raw text with tenant/branch context, sends it to the AI
 * orchestration engine, and dispatches the resulting structured action
 * to the appropriate internal controller.
 */
/**
 * Rule-based local NLP parser that maps common phrases to structured intents.
 * Returns { action, data } or null if no match found.
 */
function parseIntentLocally(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.trim();
  const standardCurrencies = ['PGK', 'USD', 'AUD', 'EUR', 'GBP', 'NZD'];

  // 1. Expenses & Income
  const expenseMatch = cleaned.match(/^(?:log\s+)?expense\s+([0-9]+(?:\.[0-9]+)?)(?:\s+([a-zA-Z]{3}))?(?:\s+(.+))?$/i);
  if (expenseMatch) {
    let amount = parseFloat(expenseMatch[1]);
    let currency = 'PGK';
    let notes = '';
    if (expenseMatch[2]) {
      const code = expenseMatch[2].toUpperCase();
      if (standardCurrencies.includes(code)) {
        currency = code;
        notes = expenseMatch[3] ? expenseMatch[3].trim() : '';
      } else {
        notes = (expenseMatch[2] + (expenseMatch[3] ? ' ' + expenseMatch[3] : '')).trim();
      }
    } else {
      notes = expenseMatch[3] ? expenseMatch[3].trim() : '';
    }
    return {
      action: 'CREATE_EXPENSE',
      data: { amount, currency, notes: notes || 'Logged via local regex parser' }
    };
  }

  const incomeMatch = cleaned.match(/^(?:log\s+)?(?:income|received)\s+([0-9]+(?:\.[0-9]+)?)(?:\s+([a-zA-Z]{3}))?(?:\s+(.+))?$/i);
  if (incomeMatch) {
    let amount = parseFloat(incomeMatch[1]);
    let currency = 'PGK';
    let notes = '';
    if (incomeMatch[2]) {
      const code = incomeMatch[2].toUpperCase();
      if (standardCurrencies.includes(code)) {
        currency = code;
        notes = incomeMatch[3] ? incomeMatch[3].trim() : '';
      } else {
        notes = (incomeMatch[2] + (incomeMatch[3] ? ' ' + incomeMatch[3] : '')).trim();
      }
    } else {
      notes = incomeMatch[3] ? incomeMatch[3].trim() : '';
    }
    return {
      action: 'CREATE_INCOME',
      data: { amount, currency, notes: notes || 'Logged via local regex parser' }
    };
  }

  // 2. Sales Leads
  const leadMatch = cleaned.match(/^(?:create|add)\s+lead\s+(.+)$/i);
  if (leadMatch) {
    let remaining = leadMatch[1].trim();
    let email = 'lead@sales.com';
    let dealValue = 0;

    const emailMatch = remaining.match(/email\s+(\S+)/i);
    if (emailMatch) {
      email = emailMatch[1];
      remaining = remaining.replace(emailMatch[0], '').trim();
    }

    const valueMatch = remaining.match(/value\s+([0-9]+(?:\.[0-9]+)?)/i);
    if (valueMatch) {
      dealValue = parseFloat(valueMatch[1]);
      remaining = remaining.replace(valueMatch[0], '').trim();
    }

    return {
      action: 'CREATE_LEAD',
      data: { fullName: remaining.trim(), email, dealValue }
    };
  }

  // 3. Workspace Tasks
  const taskMatch = cleaned.match(/^(?:add|create)\s+task\s+(.+)$/i);
  if (taskMatch) {
    return {
      action: 'CREATE_WORKSPACE_TASK',
      data: { title: taskMatch[1].trim() }
    };
  }

  // 4. Store Inventory
  const itemMatch = cleaned.match(/^(?:add\s+store\s+item|create\s+item)\s+(.+)$/i);
  if (itemMatch) {
    let remaining = itemMatch[1].trim();
    let price = 0;
    const priceMatch = remaining.match(/price\s+([0-9]+(?:\.[0-9]+)?)/i);
    if (priceMatch) {
      price = parseFloat(priceMatch[1]);
      remaining = remaining.replace(priceMatch[0], '').trim();
    }
    return {
      action: 'CREATE_STORE_ITEM',
      data: { title: remaining.trim(), price }
    };
  }

  // 5. Logistics Shipments
  const shipmentMatch = cleaned.match(/^(?:create\s+shipment\s+to)\s+(.+)$/i);
  if (shipmentMatch) {
    return {
      action: 'CREATE_SHIPMENT',
      data: { destinationAddress: shipmentMatch[1].trim() }
    };
  }

  return null;
}

async function processNaturalLanguageIntent(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId || null;
  const { text, sourceChannel = 'INTERNAL' } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required and must be a non-empty string.' });
  }

  let aiResult = null;
  if (AI_ENGINE_SERVICE_URL) {
    try {
      const aiResp = await aiClient.post('/parse-intent', {
        text,
        tenantId,
        branchId,
        sourceChannel,
      });
      aiResult = aiResp.data;
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      console.warn('[intentController] AI orchestration call failed, falling back to local parser:', detail);
      aiResult = parseIntentLocally(text);
    }
  } else {
    aiResult = parseIntentLocally(text);
  }

  if (!aiResult || !aiResult.action) {
    return res.status(422).json({ error: "Try: 'log expense 250', 'create lead John Doe', or 'add task Call supplier'" });
  }

  try {
    const executionResult = await executeIntentAction(aiResult, { tenantId, branchId, authUser: req.authUser });

    eventDispatcher.dispatchAsync('intent.processed', tenantId, {
      sourceChannel,
      text,
      action: aiResult.action,
      executionResult: executionResult.body,
    });

    return res.status(executionResult.statusCode || 200).json({
      recognizedAction: aiResult.action,
      data: aiResult.data,
      result: executionResult.body,
    });
  } catch (err) {
    console.error('[intentController] failed to execute recognized intent', err);
    return res.status(500).json({
      error: 'Recognized intent but failed to execute it.',
      recognizedAction: aiResult.action,
      detail: err.message,
    });
  }
}

/**
 * Maps a structured AI action payload, e.g.
 *   { action: "CREATE_EXPENSE", data: { amount: 450, notes: "Boroko Branch hosting" } }
 * onto the corresponding internal controller call.
 */
async function executeIntentAction(aiResult, context) {
  const { action, data = {} } = aiResult;
  const { tenantId, branchId, authUser } = context;

  const fakeReq = {
    tenantId,
    branchId,
    authUser,
    body: {},
    params: {},
    query: {},
  };

  switch (action) {
    case 'CREATE_EXPENSE': {
      fakeReq.body = {
        transactionType: 'EXPENSE',
        amount: data.amount,
        currency: data.currency || 'PGK',
        description: data.notes || data.description || 'Logged via AI intent engine',
      };
      const res = createCapturingResponse();
      await financeController.logTransaction(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_INCOME': {
      fakeReq.body = {
        transactionType: 'INCOME',
        amount: data.amount,
        currency: data.currency || 'PGK',
        description: data.notes || data.description || 'Logged via AI intent engine',
      };
      const res = createCapturingResponse();
      await financeController.logTransaction(fakeReq, res);
      return res.capture;
    }

    case 'LOG_MANUAL_TRANSACTION': {
      fakeReq.body = {
        transactionType: data.transactionType || 'EXPENSE',
        amount: data.amount,
        currency: data.currency || 'PGK',
        notes: data.notes,
      };
      const res = createCapturingResponse();
      await financeController.logManualTransaction(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_SHIPMENT': {
      const shipment = await logisticsService.createShipment({
        tenantId,
        branchId,
        carrier: data.carrier || 'POST_PNG',
        originAddress: data.originAddress,
        destinationAddress: data.destinationAddress,
        weightKg: data.weightKg,
      });
      return { statusCode: 201, body: shipment };
    }

    case 'UPDATE_SHIPMENT_STATUS': {
      if (!data.shipmentId) {
        throw new Error('UPDATE_SHIPMENT_STATUS requires data.shipmentId.');
      }
      const shipment = await logisticsService.fetchTrackingStatus(data.shipmentId);
      return { statusCode: 200, body: shipment };
    }

    case 'CREATE_HR_PROFILE': {
      fakeReq.body = {
        fullName: data.fullName,
        positionTitle: data.positionTitle,
        salaryAmount: data.salaryAmount,
        salaryCurrency: data.salaryCurrency || 'PGK',
        hireDate: data.hireDate,
      };
      const res = createCapturingResponse();
      await hrController.createProfile(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_HR_STATUS': {
      if (!data.profileId) {
        throw new Error('UPDATE_HR_STATUS requires data.profileId.');
      }
      fakeReq.params = { id: data.profileId };
      fakeReq.body = {
        isActive: data.isActive,
        terminationDate: data.terminationDate,
        positionTitle: data.positionTitle,
      };
      const res = createCapturingResponse();
      await hrController.updateProfileStatus(fakeReq, res);
      return res.capture;
    }

    case 'PULL_HR_PROFILE': {
      fakeReq.query = { branchId };
      const res = createCapturingResponse();
      await hrController.listProfiles(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_LEAD': {
      fakeReq.body = {
        fullName: data.fullName || data.full_name,
        email: data.email,
        dealValue: data.dealValue || data.deal_value || 0,
        stage: data.stage || 'Prospect',
      };
      const res = createCapturingResponse();
      await salesController.createLead(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_STORE_ITEM': {
      fakeReq.body = {
        title: data.title,
        price: data.price || 0,
        description: data.description,
        inventoryCount: data.inventoryCount || data.inventory_count || 0,
      };
      const res = createCapturingResponse();
      await storeController.createItem(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_STORE_PAGE': {
      fakeReq.body = {
        title: data.title,
        slug: data.slug,
        content: data.content,
        isPublished: data.isPublished !== undefined ? data.isPublished : data.is_published,
      };
      const res = createCapturingResponse();
      await storeController.createPage(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_WORKSPACE_TASK': {
      fakeReq.body = {
        title: data.title,
        description: data.description,
        assigneeUserId: data.assigneeUserId || data.assignee_user_id,
        status: data.status || 'TODO',
        priority: data.priority || 'NORMAL',
        dueDate: data.dueDate || data.due_date,
      };
      const res = createCapturingResponse();
      await workspaceController.createTask(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_WORKSPACE_EVENT': {
      fakeReq.body = {
        title: data.title,
        description: data.description,
        startsAt: data.startsAt || data.starts_at,
        endsAt: data.endsAt || data.ends_at,
        location: data.location,
        organizerUserId: data.organizerUserId || data.organizer_user_id,
      };
      const res = createCapturingResponse();
      await workspaceController.createEvent(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_WORKSPACE_DOCUMENT': {
      fakeReq.body = {
        title: data.title,
        category: data.category,
        url: data.url,
        content: data.content,
        status: data.status || 'DRAFT',
        notes: data.notes,
      };
      const res = createCapturingResponse();
      await workspaceController.createDocument(fakeReq, res);
      return res.capture;
    }

    case 'CONVERT_LEAD':
    case 'CONVERT_LEAD_TO_CUSTOMER':
    case 'CONVERT_LEAD_AND_TASK': {
      const leadId = data.leadId || data.lead_id;
      const db = require('../db');

      const leadRes = await db.query(
        'SELECT * FROM sales_leads WHERE id = $1 AND tenant_id = $2',
        [leadId, tenantId]
      );
      if (leadRes.rowCount === 0) {
        throw new Error(`Lead ${leadId} not found in scope.`);
      }
      const lead = leadRes.rows[0];

      // Update lead to Won to trigger automatic flow
      fakeReq.params = { id: leadId };
      fakeReq.body = { stage: 'Won' };
      const resStage = createCapturingResponse();
      await salesController.updateLeadStage(fakeReq, resStage);

      // Open an extra custom task (atomic follow-up)
      fakeReq.params = {};
      fakeReq.body = {
        title: data.taskTitle || `AI: Extended follow up for ${lead.full_name}`,
        description: data.taskDescription || 'Onboarding tasks generated via multi-action NLP command.',
        dueDate: data.dueDate || data.due_date,
        status: 'TODO',
        priority: 'HIGH'
      };
      const resTask = createCapturingResponse();
      await workspaceController.createTask(fakeReq, resTask);

      return {
        statusCode: 200,
        body: {
          message: 'Multi-action lead conversion and task creation executed successfully.',
          lead: resStage.capture.body,
          task: resTask.capture.body
        }
      };
    }

    default:
      throw new Error(`Unrecognized or unsupported action "${action}" returned by AI engine.`);
  }
}

module.exports = { processNaturalLanguageIntent };
