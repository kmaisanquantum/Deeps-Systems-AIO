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

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_BASE_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';

console.log(`[intentController] Startup Configuration: GROQ_API_KEY configured: ${!!GROQ_API_KEY}, GROQ_MODEL: "${GROQ_MODEL}", GROQ_BASE_URL: "${GROQ_BASE_URL}"`);

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

/**
 * Executes a Chat Completion request to Groq using the configured llama model to map natural language to structured actions.
 */
/**
 * Executes a Chat Completion request to Groq using the configured llama model and provides prior conversation turns.
 */
async function parseIntentWithLlama(text, history) {
  if (!GROQ_API_KEY) {
    return null;
  }

  // Clean trailing/leading slashes from base URL
  let baseUrl = GROQ_BASE_URL.trim();
  if (baseUrl.endsWith('/')) {
    baseUrl = baseUrl.slice(0, -1);
  }
  const completionsUrl = `${baseUrl}/chat/completions`;

  const systemPrompt = `You are the Deeps Systems AIO Conversational Workspace Assistant.
Your task is to parse a free-form natural language user instruction or query and map it to one of our structured system actions.
You MUST respond with a valid JSON object matching this schema:
{
  "action": "ACTION_NAME",
  "data": { ... }
}

If the user query is a greeting, general workspace question, pure informational small talk, or conversational list summary, respond with action "ANSWER" and include the conversational answer in data.message:
{
  "action": "ANSWER",
  "data": {
    "message": "Your helpful conversational assistant response..."
  }
}

SUPPORTED ACTIONS AND EXPECTED "data" FIELDS:

1. CREATE_EXPENSE: Log a financial expense transaction.
   Fields:
   - "amount": number (required, e.g. 250)
   - "currency": string (e.g. "PGK", "USD", "AUD". Default: "PGK")
   - "notes": string (e.g. "Office supplies")

2. CREATE_INCOME: Log a financial income transaction.
   Fields:
   - "amount": number (required)
   - "currency": string (Default: "PGK")
   - "notes": string

3. LOG_MANUAL_TRANSACTION: Manual financial transaction entry.
   Fields:
   - "transactionType": "EXPENSE" or "INCOME" (required)
   - "amount": number (required)
   - "currency": string (Default: "PGK")
   - "notes": string

4. LIST_TRANSACTIONS: List financial transactions or expenses.
   Fields:
   - "transactionType": "EXPENSE", "INCOME" or "ALL" (optional)

5. CREATE_SHIPMENT: Logistics shipment creation.
   Fields:
   - "carrier": "POST_PNG" or "DHL" (Default: "POST_PNG")
   - "originAddress": string
   - "destinationAddress": string (required)
   - "weightKg": number (optional)

6. LIST_SHIPMENTS: View shipment list.
   Fields: {}

7. UPDATE_SHIPMENT_STATUS: Trace or update shipment status.
   Fields:
   - "shipmentId": string (required)

8. CREATE_HR_PROFILE: Create employee HR record. (Admin/Superadmin only)
   Fields:
   - "fullName": string (required)
   - "positionTitle": string (required)
   - "salaryAmount": number (required)
   - "salaryCurrency": string (Default: "PGK")
   - "hireDate": string (date format "YYYY-MM-DD", e.g. "2026-07-18")

9. LIST_HR_PROFILES: View employee HR profiles. (Admin/Superadmin only)
   Fields: {}

10. UPDATE_HR_STATUS: Terminate, activate or update employee details. (Admin/Superadmin only)
    Fields:
    - "profileId": string (UUID format, optional if employeeName is provided)
    - "employeeName": string (optional, name to resolve and locate)
    - "isActive": boolean (optional)
    - "terminationDate": string (date format "YYYY-MM-DD" or null)
    - "positionTitle": string (optional)
    - "salaryAmount": number (optional)

11. DELETE_HR_PROFILE: Delete employee HR record. (Admin/Superadmin only)
    Fields:
    - "profileId": string (optional)
    - "employeeName": string (optional)

12. CREATE_LEAD: Create sales lead.
    Fields:
    - "fullName": string (required)
    - "email": string (optional, default "lead@sales.com")
    - "dealValue": number (optional, default 0)
    - "stage": string (optional, default "Prospect")

13. LIST_LEADS: View sales leads list.
    Fields: {}

14. UPDATE_LEAD: Update details or stage of a lead.
    Fields:
    - "leadId": string (UUID, optional if leadName is provided)
    - "leadName": string (optional, name to resolve and locate)
    - "fullName": string (optional)
    - "email": string (optional)
    - "dealValue": number (optional)
    - "stage": string (optional, e.g. "Prospect", "Won", "Lost")

15. DELETE_LEAD: Delete sales lead.
    Fields:
    - "leadId": string (optional)
    - "leadName": string (optional)

16. CREATE_STORE_ITEM: Web store product item.
    Fields:
    - "title": string (required)
    - "price": number (optional, default 0)
    - "description": string (optional)
    - "inventoryCount": number (optional, default 0)

17. LIST_STORE_ITEMS: List web store items.
    Fields: {}

18. UPDATE_STORE_ITEM: Update product item details.
    Fields:
    - "itemId": string (UUID, optional if itemName is provided)
    - "itemName": string (optional)
    - "title": string (optional)
    - "price": number (optional)
    - "inventoryCount": number (optional)
    - "description": string (optional)

19. DELETE_STORE_ITEM: Delete web store product item.
    Fields:
    - "itemId": string (optional)
    - "itemName": string (optional)

20. CREATE_WORKSPACE_TASK: Create team workspace task.
    Fields:
    - "title": string (required)
    - "description": string (optional)
    - "assigneeUserId": string (optional)
    - "status": string (optional, default "TODO")
    - "priority": "LOW", "NORMAL", "HIGH" (optional, default "NORMAL")
    - "dueDate": string (date format "YYYY-MM-DD")

21. LIST_WORKSPACE_TASKS: List team tasks.
    Fields: {}

22. UPDATE_WORKSPACE_TASK: Update task title, status, or details.
    Fields:
    - "taskId": string (UUID, optional if taskTitle is provided)
    - "taskTitle": string (optional, current task title to search/match)
    - "title": string (optional, new title)
    - "status": "TODO" | "IN_PROGRESS" | "DONE" (optional)
    - "priority": "LOW" | "NORMAL" | "HIGH" (optional)
    - "assigneeUserId": string (optional)

23. DELETE_WORKSPACE_TASK: Delete team task.
    Fields:
    - "taskId": string (optional)
    - "taskTitle": string (optional)

24. CONVERT_LEAD_AND_TASK: Lead conversion to won and extra task trigger.
    Fields:
    - "leadId": string (required, UUID of the lead)
    - "taskTitle": string (optional, default onboarding title)
    - "taskDescription": string (optional)
    - "dueDate": string (date format "YYYY-MM-DD")

CRITICAL INSTRUCTIONS:
- You must ONLY return a raw JSON object with keys "action" and "data".
- No conversational preamble, explanation, markdown blocks, or surrounding text. Just valid JSON.
`;

  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  if (Array.isArray(history)) {
    history.forEach(turn => {
      if (turn && (turn.role === 'user' || turn.role === 'assistant') && turn.content) {
        messages.push({ role: turn.role, content: turn.content });
      }
    });
  }

  messages.push({ role: 'user', content: text });

  try {
    const response = await axios.post(
      completionsUrl,
      {
        model: GROQ_MODEL,
        messages,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    if (response && response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message) {
      const rawContent = response.data.choices[0].message.content;
      try {
        const parsed = JSON.parse(rawContent);
        if (parsed && typeof parsed === 'object' && parsed.action) {
          return parsed;
        } else {
          return { error: true, details: 'Response JSON is missing structured action field' };
        }
      } catch (parseErr) {
        console.warn('[intentController] Failed to parse JSON content from Groq Llama:', parseErr.message, rawContent);
        return { error: true, details: `JSON parse error: ${parseErr.message}` };
      }
    }
    return { error: true, details: 'Empty or malformed completions choice payload returned by Groq' };
  } catch (err) {
    let errMsg = err.message;
    if (err.response) {
      errMsg = JSON.stringify(err.response.status) + ' ' + JSON.stringify(err.response.data);
    }
    console.warn('[intentController] Groq completions call failed: ' + errMsg);
    return { error: true, details: errMsg };
  }
}

async function processNaturalLanguageIntent(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId || null;
  const { text, history = [], sourceChannel = 'INTERNAL' } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required and must be a non-empty string.' });
  }

  let aiResult = null;

  // 1. First choice: AI_ENGINE_SERVICE_URL if configured
  if (AI_ENGINE_SERVICE_URL) {
    try {
      console.log('[intentController] First Choice: AI_ENGINE_SERVICE_URL...');
      const aiResp = await aiClient.post('/parse-intent', {
        text,
        tenantId,
        branchId,
        sourceChannel,
      });
      aiResult = aiResp.data;
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      console.warn('[intentController] AI_ENGINE_SERVICE_URL call failed, falling back to other parser:', detail);
    }
  }

  let groqErrorDetails = null;

  // 2. Second choice: GROQ_API_KEY calling parseIntentWithLlama
  if ((!aiResult || !aiResult.action) && GROQ_API_KEY) {
    try {
      console.log('[intentController] Second Choice: parseIntentWithLlama using Groq...');
      const responseObj = await parseIntentWithLlama(text, history);
      if (responseObj && responseObj.error === true) {
        groqErrorDetails = responseObj.details;
        aiResult = null;
      } else {
        aiResult = responseObj;
      }
    } catch (err) {
      groqErrorDetails = err.message;
      console.warn('[intentController] Groq completions call failed, falling back to local parser:', err.message);
    }
  }

  // 3. Third choice: parseIntentLocally fallback
  if (!aiResult || !aiResult.action) {
    console.log('[intentController] Third Choice: parseIntentLocally fallback...');
    aiResult = parseIntentLocally(text);
  }

  if (!aiResult || !aiResult.action) {
    if (GROQ_API_KEY && groqErrorDetails) {
      return res.status(502).json({
        success: false,
        error: `AI engine (Groq) call failed: ${groqErrorDetails}. Falling back was unsuccessful.`
      });
    }
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

  const adminOnlyActions = [
    'CREATE_HR_PROFILE',
    'UPDATE_HR_STATUS',
    'PULL_HR_PROFILE',
    'LIST_HR_PROFILES',
    'DELETE_HR_PROFILE'
  ];
  if (adminOnlyActions.includes(action)) {
    const role = authUser ? authUser.role : null;
    if (role !== 'admin' && role !== 'superadmin') {
      return {
        statusCode: 403,
        body: { error: 'Forbidden: Admin access required.' }
      };
    }
  }

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

    case 'ANSWER': {
      return {
        statusCode: 200,
        body: { message: data.message || 'I am ready to assist you.' }
      };
    }

    case 'LIST_TRANSACTIONS':
    case 'LIST_EXPENSES': {
      const res = createCapturingResponse();
      await financeController.listTransactions(fakeReq, res);
      return res.capture;
    }

    case 'LIST_LEADS': {
      const res = createCapturingResponse();
      await salesController.listLeads(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_LEAD': {
      let leadId = data.leadId || data.id;
      if (!leadId && (data.leadName || data.fullName)) {
        const nameToMatch = (data.leadName || data.fullName).toLowerCase().trim();
        const leadList = await db.query('SELECT id, full_name FROM sales_leads WHERE tenant_id = $1', [tenantId]);
        const found = leadList.rows.find(r => r.full_name.toLowerCase().includes(nameToMatch));
        if (found) leadId = found.id;
      }
      if (!leadId) {
        throw new Error('Could not resolve Lead record ID by name.');
      }
      fakeReq.params = { id: leadId };
      fakeReq.body = {
        full_name: data.fullName || data.full_name,
        email: data.email,
        deal_value: data.dealValue !== undefined ? data.dealValue : data.deal_value,
        stage: data.stage
      };
      const res = createCapturingResponse();
      await salesController.updateLead(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_LEAD': {
      let leadId = data.leadId || data.id;
      if (!leadId && (data.leadName || data.fullName)) {
        const nameToMatch = (data.leadName || data.fullName).toLowerCase().trim();
        const leadList = await db.query('SELECT id, full_name FROM sales_leads WHERE tenant_id = $1', [tenantId]);
        const found = leadList.rows.find(r => r.full_name.toLowerCase().includes(nameToMatch));
        if (found) leadId = found.id;
      }
      if (!leadId) {
        throw new Error('Could not resolve Lead record ID by name.');
      }
      fakeReq.params = { id: leadId };
      const res = createCapturingResponse();
      await salesController.deleteLead(fakeReq, res);
      return res.capture;
    }

    case 'LIST_STORE_ITEMS': {
      const res = createCapturingResponse();
      await storeController.listItems(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_STORE_ITEM': {
      let itemId = data.itemId || data.id;
      if (!itemId && (data.itemName || data.title)) {
        const nameToMatch = (data.itemName || data.title).toLowerCase().trim();
        const itemList = await db.query('SELECT id, title FROM store_items WHERE tenant_id = $1', [tenantId]);
        const found = itemList.rows.find(r => r.title.toLowerCase().includes(nameToMatch));
        if (found) itemId = found.id;
      }
      if (!itemId) {
        throw new Error('Could not resolve Store Item record ID by name.');
      }
      fakeReq.params = { id: itemId };
      fakeReq.body = {
        title: data.title || data.title,
        price: data.price,
        inventoryCount: data.inventoryCount !== undefined ? data.inventoryCount : data.inventory_count,
        description: data.description
      };
      const res = createCapturingResponse();
      await storeController.updateItem(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_STORE_ITEM': {
      let itemId = data.itemId || data.id;
      if (!itemId && (data.itemName || data.title)) {
        const nameToMatch = (data.itemName || data.title).toLowerCase().trim();
        const itemList = await db.query('SELECT id, title FROM store_items WHERE tenant_id = $1', [tenantId]);
        const found = itemList.rows.find(r => r.title.toLowerCase().includes(nameToMatch));
        if (found) itemId = found.id;
      }
      if (!itemId) {
        throw new Error('Could not resolve Store Item record ID by name.');
      }
      fakeReq.params = { id: itemId };
      const res = createCapturingResponse();
      await storeController.deleteItem(fakeReq, res);
      return res.capture;
    }

    case 'LIST_WORKSPACE_TASKS': {
      const res = createCapturingResponse();
      await workspaceController.listTasks(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_WORKSPACE_TASK': {
      let taskId = data.taskId || data.id;
      if (!taskId && (data.taskTitle || data.title)) {
        const nameToMatch = (data.taskTitle || data.title).toLowerCase().trim();
        const taskList = await db.query('SELECT id, title FROM workspace_tasks WHERE tenant_id = $1', [tenantId]);
        const found = taskList.rows.find(r => r.title.toLowerCase().includes(nameToMatch));
        if (found) taskId = found.id;
      }
      if (!taskId) {
        throw new Error('Could not resolve Workspace Task ID by title.');
      }
      fakeReq.params = { id: taskId };
      fakeReq.body = {
        status: data.status,
        title: data.title,
        priority: data.priority,
        assigneeUserId: data.assigneeUserId || data.assignee_user_id
      };
      const res = createCapturingResponse();
      await workspaceController.updateTaskStatus(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_WORKSPACE_TASK': {
      let taskId = data.taskId || data.id;
      if (!taskId && (data.taskTitle || data.title)) {
        const nameToMatch = (data.taskTitle || data.title).toLowerCase().trim();
        const taskList = await db.query('SELECT id, title FROM workspace_tasks WHERE tenant_id = $1', [tenantId]);
        const found = taskList.rows.find(r => r.title.toLowerCase().includes(nameToMatch));
        if (found) taskId = found.id;
      }
      if (!taskId) {
        throw new Error('Could not resolve Workspace Task ID by title.');
      }
      fakeReq.params = { id: taskId };
      const res = createCapturingResponse();
      await workspaceController.deleteTask(fakeReq, res);
      return res.capture;
    }

    case 'LIST_HR_PROFILES': {
      fakeReq.query = { branchId };
      const res = createCapturingResponse();
      await hrController.listProfiles(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_HR_PROFILE': {
      let profileId = data.profileId || data.id;
      if (!profileId && (data.employeeName || data.fullName)) {
        const nameToMatch = (data.employeeName || data.fullName).toLowerCase().trim();
        const profileList = await db.query('SELECT id, full_name FROM hr_profiles WHERE tenant_id = $1', [tenantId]);
        const found = profileList.rows.find(r => r.full_name.toLowerCase().includes(nameToMatch));
        if (found) profileId = found.id;
      }
      if (!profileId) {
        throw new Error('Could not resolve HR Profile ID by employee name.');
      }
      fakeReq.params = { id: profileId };
      const res = createCapturingResponse();
      await hrController.deleteProfile(fakeReq, res);
      return res.capture;
    }

    case 'LIST_SHIPMENTS': {
      const result = await db.query(
        'SELECT * FROM logistics_shipments WHERE tenant_id = $1 ORDER BY created_at DESC',
        [tenantId]
      );
      return { statusCode: 200, body: result.rows };
    }

    default:
      throw new Error(`Unrecognized or unsupported action "${action}" returned by AI engine.`);
  }
}

module.exports = { processNaturalLanguageIntent };
