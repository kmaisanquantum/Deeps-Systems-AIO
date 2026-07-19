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

const communicationController = require('./communicationController');
const devopsController = require('./devopsController');
const learningController = require('./learningController');
const feesController = require('./feesController');
const bankingController = require('./bankingController');
const adminController = require('./adminController');
const superadminController = require('./superadminController');

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

  // 6. Navigation: "open <module>"
  const openMatch = cleaned.match(/^(?:open|navigate\s+to)\s+(.+)$/i);
  if (openMatch) {
    return {
      action: 'OPEN_MODULE',
      data: { module: openMatch[1].trim().toLowerCase() }
    };
  }

  // 7. Communication: "send email to <target>"
  const emailToMatch = cleaned.match(/^send\s+email\s+to\s+(\S+)(?:\s+(.+))?$/i);
  if (emailToMatch) {
    return {
      action: 'SEND_MESSAGE',
      data: {
        channel: 'EMAIL',
        to: emailToMatch[1].trim(),
        subject: 'AI Message',
        message: emailToMatch[2] ? emailToMatch[2].trim() : 'Hello from Deeps AI local fallback.'
      }
    };
  }

  // 8. Admin: "list users"
  const listUsersMatch = cleaned.match(/^list\s+users$/i);
  if (listUsersMatch) {
    return {
      action: 'LIST_USERS',
      data: {}
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

1. OPEN_MODULE: Navigation routing to a frontend module view.
   Fields:
   - "module": string (required, one of: "comms", "hr", "finance", "logistics", "store", "sales", "workspace", "admin", "superadmin", "devops", "learning")

2. SEND_MESSAGE: Send communication logs.
   Fields:
   - "channel": "WHATSAPP", "EMAIL", or "SMS" (required)
   - "to": string (required, phone number or email address)
   - "subject": string (optional, for email)
   - "message": string (required)

3. GET_FINANCE_SUMMARY: Retrieve finance dashboard statistics.
   Fields: {}

4. CREATE_EXPENSE: Log a financial expense transaction.
   Fields:
   - "amount": number (required, e.g. 250)
   - "currency": string (e.g. "PGK", "USD", "AUD". Default: "PGK")
   - "notes": string (e.g. "Office supplies")

5. CREATE_INCOME: Log a financial income transaction.
   Fields:
   - "amount": number (required)
   - "currency": string (Default: "PGK")
   - "notes": string

6. LOG_MANUAL_TRANSACTION: Manual financial transaction entry.
   Fields:
   - "transactionType": "EXPENSE" or "INCOME" (required)
   - "amount": number (required)
   - "currency": string (Default: "PGK")
   - "notes": string

7. LIST_TRANSACTIONS: List financial transactions or expenses.
   Fields:
   - "transactionType": "EXPENSE", "INCOME" or "ALL" (optional)

8. CREATE_SHIPMENT: Logistics shipment creation.
   Fields:
   - "carrier": "POST_PNG" or "DHL" (Default: "POST_PNG")
   - "originAddress": string
   - "destinationAddress": string (required)
   - "weightKg": number (optional)

9. LIST_SHIPMENTS: View shipment list.
   Fields: {}

10. UPDATE_SHIPMENT_STATUS: Trace or update shipment status.
    Fields:
    - "shipmentId": string (required)

11. CREATE_HR_PROFILE: Create employee HR record. (Admin/Superadmin only)
    Fields:
    - "fullName": string (required)
    - "positionTitle": string (required)
    - "salaryAmount": number (required)
    - "salaryCurrency": string (Default: "PGK")
    - "hireDate": string (date format "YYYY-MM-DD", e.g. "2026-07-18")

12. LIST_HR_PROFILES: View employee HR profiles. (Admin/Superadmin only)
    Fields: {}

13. UPDATE_HR_STATUS: Terminate, activate or update employee details. (Admin/Superadmin only)
    Fields:
    - "profileId": string (UUID format, optional if employeeName is provided)
    - "employeeName": string (optional, name to resolve and locate)
    - "isActive": boolean (optional)
    - "terminationDate": string (date format "YYYY-MM-DD" or null)
    - "positionTitle": string (optional)
    - "salaryAmount": number (optional)

14. DELETE_HR_PROFILE: Delete employee HR record. (Admin/Superadmin only)
    Fields:
    - "profileId": string (optional)
    - "employeeName": string (optional)

15. CREATE_LEAD: Create sales lead.
    Fields:
    - "fullName": string (required)
    - "email": string (optional, default "lead@sales.com")
    - "dealValue": number (optional, default 0)
    - "stage": string (optional, default "Prospect")

16. LIST_LEADS: View sales leads list.
    Fields: {}

17. UPDATE_LEAD: Update details or stage of a lead.
    Fields:
    - "leadId": string (UUID, optional if leadName is provided)
    - "leadName": string (optional, name to resolve and locate)
    - "fullName": string (optional)
    - "email": string (optional)
    - "dealValue": number (optional)
    - "stage": string (optional, e.g. "Prospect", "Won", "Lost")

18. DELETE_LEAD: Delete sales lead.
    Fields:
    - "leadId": string (optional)
    - "leadName": string (optional)

19. CONVERT_LEAD_AND_TASK: Lead conversion to won and extra task trigger.
    Fields:
    - "leadId": string (required, UUID of the lead)
    - "taskTitle": string (optional, default onboarding title)
    - "taskDescription": string (optional)
    - "dueDate": string (date format "YYYY-MM-DD")

20. CREATE_STORE_ITEM: Web store product item.
    Fields:
    - "title": string (required)
    - "price": number (optional, default 0)
    - "description": string (optional)
    - "inventoryCount": number (optional, default 0)

21. LIST_STORE_ITEMS: List web store items.
    Fields: {}

22. UPDATE_STORE_ITEM: Update product item details.
    Fields:
    - "itemId": string (UUID, optional if itemName is provided)
    - "itemName": string (optional)
    - "title": string (optional)
    - "price": number (optional)
    - "inventoryCount": number (optional)
    - "description": string (optional)

23. DELETE_STORE_ITEM: Delete web store product item.
    Fields:
    - "itemId": string (optional)
    - "itemName": string (optional)

24. LIST_STORE_PAGES: List web store pages.
    Fields: {}

25. CREATE_STORE_PAGE: Web store page.
    Fields:
    - "title": string (required)
    - "slug": string (required, URL friendly, e.g. "about-us")
    - "content": string (required)
    - "isPublished": boolean (optional, default true)

26. UPDATE_STORE_PAGE: Update web store page details.
    Fields:
    - "pageId": string (required, UUID)
    - "title": string (optional)
    - "slug": string (optional)
    - "content": string (optional)

27. DELETE_STORE_PAGE: Delete web store page.
    Fields:
    - "pageId": string (required, UUID)

28. LIST_STORE_CHECKOUTS: List customer checkouts.
    Fields: {}

29. CREATE_STORE_CHECKOUT: Create web store checkout.
    Fields:
    - "itemId": string (required, UUID)
    - "quantity": number (optional, default 1)
    - "customerEmail": string (required)
    - "notes": string (optional)

30. UPDATE_STORE_CHECKOUT_STATUS: Update customer checkout status.
    Fields:
    - "checkoutId": string (required, UUID)
    - "status": "PENDING", "COMPLETED", or "CANCELLED" (required)

31. CREATE_WORKSPACE_TASK: Create team workspace task.
    Fields:
    - "title": string (required)
    - "description": string (optional)
    - "assigneeUserId": string (optional)
    - "status": string (optional, default "TODO")
    - "priority": "LOW", "NORMAL", "HIGH" (optional, default "NORMAL")
    - "dueDate": string (date format "YYYY-MM-DD")

32. LIST_WORKSPACE_TASKS: List team tasks.
    Fields: {}

33. UPDATE_WORKSPACE_TASK: Update task title, status, or details.
    Fields:
    - "taskId": string (UUID, optional if taskTitle is provided)
    - "taskTitle": string (optional, current task title to search/match)
    - "title": string (optional, new title)
    - "status": "TODO" | "IN_PROGRESS" | "DONE" (optional)
    - "priority": "LOW" | "NORMAL" | "HIGH" (optional)
    - "assigneeUserId": string (optional)

34. DELETE_WORKSPACE_TASK: Delete team task.
    Fields:
    - "taskId": string (optional)
    - "taskTitle": string (optional)

35. LIST_WORKSPACE_EVENTS: List workspace calendar events.
    Fields: {}

36. CREATE_WORKSPACE_EVENT: Create calendar event.
    Fields:
    - "title": string (required)
    - "description": string (optional)
    - "startsAt": string (ISO datetime string)
    - "endsAt": string (ISO datetime string)
    - "location": string (optional)
    - "organizerUserId": string (optional)

37. UPDATE_WORKSPACE_EVENT: Update calendar event.
    Fields:
    - "eventId": string (required, UUID)
    - "title": string (optional)
    - "description": string (optional)
    - "startsAt": string (optional, ISO datetime string)
    - "endsAt": string (optional, ISO datetime string)
    - "location": string (optional)

38. DELETE_WORKSPACE_EVENT: Delete calendar event.
    Fields:
    - "eventId": string (required, UUID)

39. LIST_WORKSPACE_DOCUMENTS: List workspace documents.
    Fields: {}

40. CREATE_WORKSPACE_DOCUMENT: Create document template.
    Fields:
    - "title": string (required)
    - "category": string (e.g. "Finance", "HR", "Logistics", "Sales")
    - "url": string (optional)
    - "content": string (optional)
    - "status": "DRAFT" or "PUBLISHED" (Default: "DRAFT")
    - "notes": string (optional)

41. UPDATE_WORKSPACE_DOCUMENT: Update workspace document details.
    Fields:
    - "documentId": string (required, UUID)
    - "title": string (optional)
    - "category": string (optional)
    - "content": string (optional)
    - "status": string (optional)

42. DELETE_WORKSPACE_DOCUMENT: Delete workspace document.
    Fields:
    - "documentId": string (required, UUID)

43. LIST_DEVOPS_NODES: List infrastructure servers/nodes.
    Fields: {}

44. CREATE_DEVOPS_NODE: Create infrastructure server/node. (Admin/Superadmin only)
    Fields:
    - "name": string (required)
    - "ipAddress": string (required, placed inside nested config block)
    - "provider": string (optional, default "VULTR")
    - "branchId": string (optional, UUID of the branch)

45. DELETE_DEVOPS_NODE: Delete server node. (Admin/Superadmin only)
    Fields:
    - "nodeId": string (required, UUID)

45a. UPDATE_DEVOPS_NODE: Update infrastructure node configurations. (Admin/Superadmin only)
    Fields:
    - "nodeId": string (required, UUID)
    - "name": string (optional)
    - "provider": string (optional)
    - "ipAddress": string (optional)
    - "status": string (optional, e.g. "active", "failed")
    - "branchId": string (optional, UUID of the branch)

45b. SYNC_DEVOPS_NODE: Sync infrastructure node connectivity.
    Fields:
    - "nodeId": string (required, UUID)

45c. LIST_PROVIDER_RESOURCES: List resources for cloud provider.
    Fields:
    - "provider": string (optional, e.g. "VULTR")

45d. LIST_DEVOPS_CREDENTIALS: List integrated devops cloud credentials.
    Fields: {}

45e. SAVE_DEVOPS_CREDENTIAL: Link/save credentials for a cloud provider. (Admin/Superadmin only)
    Fields:
    - "provider": string (required, e.g. "github", "vultr")
    - "secret": string (required)
    - "baseUrl": string (optional)

45f. DELETE_DEVOPS_CREDENTIAL: Delete a cloud provider credentials profile. (Admin/Superadmin only)
    Fields:
    - "provider": string (required, e.g. "vultr")

45g. LIST_PIPELINE_EVENTS: List execution logs/events for a DevOps pipeline.
    Fields:
    - "pipelineId": string (required, UUID)

46. LIST_PIPELINES: List DevOps pipelines.
    Fields: {}

47. CREATE_PIPELINE: Create DevOps pipeline. (Admin/Superadmin only)
    Fields:
    - "name": string (required)
    - "nodeId": string (optional, UUID of the associated node)
    - "branchId": string (optional, UUID of the branch)

48. DELETE_PIPELINE: Delete pipeline. (Admin/Superadmin only)
    Fields:
    - "pipelineId": string (required, UUID)

49. TRANSITION_PIPELINE_STAGE: Move pipeline to next stage. (Admin/Superadmin only)
    Fields:
    - "pipelineId": string (required, UUID)
    - "targetStage": string (required, e.g. "BUILD", "TEST", "PROD")

50. LIST_LEARNING_RESOURCES: List learning resources.
    Fields: {}

51. CREATE_LEARNING_RESOURCE: Create learning resource.
    Fields:
    - "title": string (required)
    - "category": string (optional)
    - "url": string (optional)

52. UPDATE_LEARNING_RESOURCE: Update learning resource details.
    Fields:
    - "resourceId": string (required, UUID)
    - "title": string (optional)
    - "category": string (optional)
    - "url": string (optional)

53. DELETE_LEARNING_RESOURCE: Delete learning resource.
    Fields:
    - "resourceId": string (required, UUID)

54. LIST_LEARNING_SCHEDULES: List study/learning schedules.
    Fields: {}

55. CREATE_LEARNING_SCHEDULE: Create a study schedule.
    Fields:
    - "resourceId": string (required, UUID)
    - "studentUserId": string (required, UUID)
    - "scheduleDate": string (required, YYYY-MM-DD)

56. LIST_FEES: List service fees invoices.
    Fields: {}

57. CREATE_FEE: Create a service fee invoice. (Admin/Superadmin only)
    Fields:
    - "title": string (required)
    - "amount": number (required)
    - "studentUserId": string (required, UUID)

58. UPDATE_FEE: Update service fee details. (Admin/Superadmin only)
    Fields:
    - "feeId": string (required, UUID)
    - "amount": number (optional)
    - "status": "PENDING" or "PAID" (optional)

59. DELETE_FEE: Delete fee record. (Admin/Superadmin only)
    Fields:
    - "feeId": string (required, UUID)

60. PAY_FEE: Log a payment against a service fee invoice.
    Fields:
    - "feeId": string (required, UUID)
    - "amountPaid": number (required)
    - "paymentMethod": string (required, e.g. "CASH", "CARD", "BSP_PAY", "KINA_IPG")

61. INITIATE_BSP_CHECKOUT: Initiate a BSP Pay IPG session. (Admin/Superadmin only)
    Fields:
    - "checkoutId": string (required, UUID)
    - "amount": number (required)
    - "currency": string (optional, default "PGK")

62. RECONCILE_MANUAL_TRANSFER: Reconcile manual bank transfer. (Admin/Superadmin only)
    Fields:
    - "checkoutId": string (required, UUID)
    - "bankReference": string (required)

63. LIST_USERS: List users of the current tenant. (Admin/Superadmin only)
    Fields: {}

64. CREATE_USER: Create a tenant user. (Admin/Superadmin only)
    Fields:
    - "username": string (required)
    - "email": string (required)
    - "rawPassword": string (required)
    - "role": "admin", "staff", "student" or "employee" (required)

65. UPDATE_USER: Update tenant user details. (Admin/Superadmin only)
    Fields:
    - "userId": string (required, UUID)
    - "username": string (optional)
    - "email": string (optional)

66. DELETE_USER: Delete tenant user. (Admin/Superadmin only)
    Fields:
    - "userId": string (required, UUID)

67. UPDATE_USER_ROLE: Update tenant user role. (Admin/Superadmin only)
    Fields:
    - "userId": string (required, UUID)
    - "role": "admin", "staff", etc. (required)

68. RESET_USER_PASSWORD: Reset user password. (Admin/Superadmin only)
    Fields:
    - "userId": string (required, UUID)
    - "newPassword": string (required)

69. UPDATE_USER_STATUS: Activate/deactivate user status. (Admin/Superadmin only)
    Fields:
    - "userId": string (required, UUID)
    - "isActive": boolean (required)

70. LIST_BRANCHES: List tenant branches. (Admin/Superadmin only)
    Fields: {}

71. CREATE_BRANCH: Create tenant branch. (Admin/Superadmin only)
    Fields:
    - "name": string (required)
    - "location": string (optional)

72. UPDATE_BRANCH: Update tenant branch details. (Admin/Superadmin only)
    Fields:
    - "branchId": string (required, UUID)
    - "name": string (optional)
    - "location": string (optional)

73. DELETE_BRANCH: Delete branch. (Admin/Superadmin only)
    Fields:
    - "branchId": string (required, UUID)

74. GET_TENANT: View details of the active tenant. (Admin/Superadmin only)
    Fields: {}

75. UPDATE_TENANT: Update active tenant configurations. (Admin/Superadmin only)
    Fields:
    - "name": string (optional)
    - "baseDomain": string (optional)

76. LIST_TENANTS: List all platform tenants. (Superadmin only)
    Fields: {}

77. CREATE_TENANT: Create a new platform tenant. (Superadmin only)
    Fields:
    - "name": string (required)
    - "subdomain": string (required)

78. UPDATE_TENANT_STATUS: Enable/disable tenant status. (Superadmin only)
    Fields:
    - "tenantId": string (required, UUID)
    - "isActive": boolean (required)

79. LIST_ALL_USERS: List all global platform users. (Superadmin only)
    Fields: {}

80. UPDATE_USER_TENANT_OR_ROLE: Change user tenant scope or role. (Superadmin only)
    Fields:
    - "userId": string (required, UUID)
    - "tenantId": string (optional, UUID)
    - "role": string (optional)
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
    return res.status(422).json({ error: "Try: 'log expense 250', 'create lead John Doe', 'add task Call supplier', 'open devops', 'send email to user@test.com', or 'list users'" });
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

  const superadminActions = [
    'LIST_TENANTS',
    'CREATE_TENANT',
    'UPDATE_TENANT_STATUS',
    'LIST_ALL_USERS',
    'UPDATE_USER_TENANT_OR_ROLE'
  ];

  const adminActions = [
    'CREATE_HR_PROFILE',
    'UPDATE_HR_STATUS',
    'PULL_HR_PROFILE',
    'LIST_HR_PROFILES',
    'DELETE_HR_PROFILE',
    'CREATE_DEVOPS_NODE',
    'UPDATE_DEVOPS_NODE',
    'DELETE_DEVOPS_NODE',
    'CREATE_PIPELINE',
    'DELETE_PIPELINE',
    'TRANSITION_PIPELINE_STAGE',
    'SAVE_DEVOPS_CREDENTIAL',
    'DELETE_DEVOPS_CREDENTIAL',
    'INITIATE_BSP_CHECKOUT',
    'RECONCILE_MANUAL_TRANSFER',
    'CREATE_FEE',
    'UPDATE_FEE',
    'DELETE_FEE',
    'LIST_USERS',
    'CREATE_USER',
    'UPDATE_USER',
    'DELETE_USER',
    'UPDATE_USER_ROLE',
    'RESET_USER_PASSWORD',
    'UPDATE_USER_STATUS',
    'LIST_BRANCHES',
    'CREATE_BRANCH',
    'UPDATE_BRANCH',
    'DELETE_BRANCH',
    'GET_TENANT',
    'UPDATE_TENANT'
  ];

  if (superadminActions.includes(action) || adminActions.includes(action)) {
    if (!authUser || !authUser.role) {
      return {
        statusCode: 403,
        body: { error: 'Forbidden: authentication and elevated role required.' }
      };
    }
    const role = authUser.role;
    if (superadminActions.includes(action)) {
      if (role !== 'superadmin') {
        return {
          statusCode: 403,
          body: { error: 'Forbidden: authentication and elevated role required.' }
        };
      }
    } else if (adminActions.includes(action)) {
      if (role !== 'admin' && role !== 'superadmin') {
        return {
          statusCode: 403,
          body: { error: 'Forbidden: authentication and elevated role required.' }
        };
      }
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

    case 'OPEN_MODULE': {
      return {
        statusCode: 200,
        body: { navigate: data.module }
      };
    }

    case 'SEND_MESSAGE': {
      fakeReq.body = {
        channel: data.channel,
        to: data.to,
        subject: data.subject,
        message: data.message
      };
      const res = createCapturingResponse();
      await communicationController.dispatchOutboundMessage(fakeReq, res);
      return res.capture;
    }

    case 'GET_FINANCE_SUMMARY': {
      const res = createCapturingResponse();
      await financeController.getFinanceSummary(fakeReq, res);
      return res.capture;
    }

    case 'LIST_DEVOPS_NODES': {
      const res = createCapturingResponse();
      await devopsController.listNodes(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_DEVOPS_NODE': {
      fakeReq.params = { id: data.nodeId };
      fakeReq.body = {
        name: data.name,
        provider: data.provider,
        config: data.ipAddress ? { ipAddress: data.ipAddress } : data.config,
        status: data.status,
        branch_id: data.branchId || null
      };
      const res = createCapturingResponse();
      await devopsController.updateNode(fakeReq, res);
      return res.capture;
    }

    case 'SYNC_DEVOPS_NODE': {
      fakeReq.params = { id: data.nodeId };
      const res = createCapturingResponse();
      await devopsController.syncNode(fakeReq, res);
      return res.capture;
    }

    case 'LIST_PROVIDER_RESOURCES': {
      fakeReq.params = { provider: data.provider || 'VULTR' };
      const res = createCapturingResponse();
      await devopsController.listProviderResources(fakeReq, res);
      return res.capture;
    }

    case 'LIST_DEVOPS_CREDENTIALS': {
      const res = createCapturingResponse();
      await devopsController.listCredentials(fakeReq, res);
      return res.capture;
    }

    case 'SAVE_DEVOPS_CREDENTIAL': {
      fakeReq.body = {
        provider: data.provider,
        secret: data.secret,
        baseUrl: data.baseUrl
      };
      const res = createCapturingResponse();
      await devopsController.saveCredential(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_DEVOPS_CREDENTIAL': {
      fakeReq.params = { provider: data.provider };
      const res = createCapturingResponse();
      await devopsController.deleteCredential(fakeReq, res);
      return res.capture;
    }

    case 'LIST_PIPELINE_EVENTS': {
      fakeReq.params = { id: data.pipelineId };
      const res = createCapturingResponse();
      await devopsController.listPipelineEvents(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_DEVOPS_NODE': {
      fakeReq.body = {
        name: data.name,
        provider: data.provider || 'VULTR',
        config: { ipAddress: data.ipAddress },
        branch_id: data.branchId || null
      };
      const res = createCapturingResponse();
      await devopsController.createNode(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_DEVOPS_NODE': {
      fakeReq.params = { id: data.nodeId };
      const res = createCapturingResponse();
      await devopsController.deleteNode(fakeReq, res);
      return res.capture;
    }

    case 'LIST_PIPELINES': {
      const res = createCapturingResponse();
      await devopsController.listPipelines(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_PIPELINE': {
      fakeReq.body = {
        name: data.name,
        node_id: data.nodeId || null,
        branch_id: data.branchId || null
      };
      const res = createCapturingResponse();
      await devopsController.createPipeline(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_PIPELINE': {
      fakeReq.params = { id: data.pipelineId };
      const res = createCapturingResponse();
      await devopsController.deletePipeline(fakeReq, res);
      return res.capture;
    }

    case 'TRANSITION_PIPELINE_STAGE': {
      fakeReq.params = { id: data.pipelineId };
      fakeReq.body = { stage: data.targetStage };
      const res = createCapturingResponse();
      await devopsController.transitionStage(fakeReq, res);
      return res.capture;
    }

    case 'LIST_LEARNING_RESOURCES': {
      const res = createCapturingResponse();
      await learningController.listResources(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_LEARNING_RESOURCE': {
      fakeReq.body = {
        title: data.title,
        category: data.category,
        url: data.url
      };
      const res = createCapturingResponse();
      await learningController.createResource(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_LEARNING_RESOURCE': {
      fakeReq.params = { id: data.resourceId };
      fakeReq.body = {
        title: data.title,
        category: data.category,
        url: data.url
      };
      const res = createCapturingResponse();
      await learningController.updateResource(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_LEARNING_RESOURCE': {
      fakeReq.params = { id: data.resourceId };
      const res = createCapturingResponse();
      await learningController.deleteResource(fakeReq, res);
      return res.capture;
    }

    case 'LIST_LEARNING_SCHEDULES': {
      const res = createCapturingResponse();
      await learningController.listSchedules(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_LEARNING_SCHEDULE': {
      fakeReq.body = {
        resourceId: data.resourceId,
        studentUserId: data.studentUserId,
        scheduleDate: data.scheduleDate
      };
      const res = createCapturingResponse();
      await learningController.createSchedule(fakeReq, res);
      return res.capture;
    }

    case 'LIST_FEES': {
      const res = createCapturingResponse();
      await feesController.listFees(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_FEE': {
      fakeReq.body = {
        title: data.title,
        amount: data.amount,
        studentUserId: data.studentUserId
      };
      const res = createCapturingResponse();
      await feesController.createFee(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_FEE': {
      fakeReq.params = { id: data.feeId };
      fakeReq.body = {
        amount: data.amount,
        status: data.status
      };
      const res = createCapturingResponse();
      await feesController.updateFee(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_FEE': {
      fakeReq.params = { id: data.feeId };
      const res = createCapturingResponse();
      await feesController.deleteFee(fakeReq, res);
      return res.capture;
    }

    case 'PAY_FEE': {
      fakeReq.params = { id: data.feeId };
      fakeReq.body = {
        amountPaid: data.amountPaid,
        paymentMethod: data.paymentMethod
      };
      const res = createCapturingResponse();
      await feesController.payFee(fakeReq, res);
      return res.capture;
    }

    case 'INITIATE_BSP_CHECKOUT': {
      fakeReq.body = {
        checkoutId: data.checkoutId,
        amount: data.amount,
        currency: data.currency || 'PGK'
      };
      const res = createCapturingResponse();
      await bankingController.initiateBSPPayCheck(fakeReq, res);
      return res.capture;
    }

    case 'RECONCILE_MANUAL_TRANSFER': {
      fakeReq.body = {
        checkoutId: data.checkoutId,
        bankReference: data.bankReference
      };
      const res = createCapturingResponse();
      await bankingController.reconcileManualTransfer(fakeReq, res);
      return res.capture;
    }

    case 'LIST_STORE_PAGES': {
      const res = createCapturingResponse();
      await storeController.listPages(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_STORE_PAGE': {
      fakeReq.params = { id: data.pageId };
      fakeReq.body = {
        title: data.title,
        slug: data.slug,
        content: data.content
      };
      const res = createCapturingResponse();
      await storeController.updatePage(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_STORE_PAGE': {
      fakeReq.params = { id: data.pageId };
      const res = createCapturingResponse();
      await storeController.deletePage(fakeReq, res);
      return res.capture;
    }

    case 'LIST_STORE_CHECKOUTS': {
      const res = createCapturingResponse();
      await storeController.listCheckouts(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_STORE_CHECKOUT': {
      fakeReq.body = {
        itemId: data.itemId,
        quantity: data.quantity || 1,
        customerEmail: data.customerEmail,
        notes: data.notes
      };
      const res = createCapturingResponse();
      await storeController.createCheckout(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_STORE_CHECKOUT_STATUS': {
      fakeReq.params = { id: data.checkoutId };
      fakeReq.body = {
        status: data.status
      };
      const res = createCapturingResponse();
      await storeController.updateCheckoutStatus(fakeReq, res);
      return res.capture;
    }

    case 'LIST_WORKSPACE_EVENTS': {
      const res = createCapturingResponse();
      await workspaceController.listEvents(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_WORKSPACE_EVENT': {
      fakeReq.params = { id: data.eventId };
      fakeReq.body = {
        title: data.title,
        description: data.description,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        location: data.location
      };
      const res = createCapturingResponse();
      await workspaceController.updateEvent(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_WORKSPACE_EVENT': {
      fakeReq.params = { id: data.eventId };
      const res = createCapturingResponse();
      await workspaceController.deleteEvent(fakeReq, res);
      return res.capture;
    }

    case 'LIST_WORKSPACE_DOCUMENTS': {
      const res = createCapturingResponse();
      await workspaceController.listDocuments(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_WORKSPACE_DOCUMENT': {
      fakeReq.params = { id: data.documentId };
      fakeReq.body = {
        title: data.title,
        category: data.category,
        content: data.content,
        status: data.status
      };
      const res = createCapturingResponse();
      await workspaceController.updateDocument(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_WORKSPACE_DOCUMENT': {
      fakeReq.params = { id: data.documentId };
      const res = createCapturingResponse();
      await workspaceController.deleteDocument(fakeReq, res);
      return res.capture;
    }

    case 'LIST_USERS': {
      const res = createCapturingResponse();
      await adminController.listUsers(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_USER': {
      fakeReq.body = {
        username: data.username,
        email: data.email,
        rawPassword: data.rawPassword,
        role: data.role
      };
      const res = createCapturingResponse();
      await adminController.createUser(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_USER': {
      fakeReq.params = { id: data.userId };
      fakeReq.body = {
        username: data.username,
        email: data.email
      };
      const res = createCapturingResponse();
      await adminController.updateUser(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_USER': {
      fakeReq.params = { id: data.userId };
      const res = createCapturingResponse();
      await adminController.deleteUser(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_USER_ROLE': {
      fakeReq.params = { id: data.userId };
      fakeReq.body = {
        role: data.role
      };
      const res = createCapturingResponse();
      await adminController.updateUserRole(fakeReq, res);
      return res.capture;
    }

    case 'RESET_USER_PASSWORD': {
      fakeReq.params = { id: data.userId };
      fakeReq.body = {
        newPassword: data.newPassword
      };
      const res = createCapturingResponse();
      await adminController.resetUserPassword(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_USER_STATUS': {
      fakeReq.params = { id: data.userId };
      fakeReq.body = {
        isActive: data.isActive
      };
      const res = createCapturingResponse();
      await adminController.updateUserStatus(fakeReq, res);
      return res.capture;
    }

    case 'LIST_BRANCHES': {
      const res = createCapturingResponse();
      await adminController.listBranches(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_BRANCH': {
      fakeReq.body = {
        name: data.name,
        location: data.location
      };
      const res = createCapturingResponse();
      await adminController.createBranch(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_BRANCH': {
      fakeReq.params = { id: data.branchId };
      fakeReq.body = {
        name: data.name,
        location: data.location
      };
      const res = createCapturingResponse();
      await adminController.updateBranch(fakeReq, res);
      return res.capture;
    }

    case 'DELETE_BRANCH': {
      fakeReq.params = { id: data.branchId };
      const res = createCapturingResponse();
      await adminController.deleteBranch(fakeReq, res);
      return res.capture;
    }

    case 'GET_TENANT': {
      const res = createCapturingResponse();
      await adminController.getTenant(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_TENANT': {
      fakeReq.body = {
        name: data.name,
        baseDomain: data.baseDomain
      };
      const res = createCapturingResponse();
      await adminController.updateTenant(fakeReq, res);
      return res.capture;
    }

    case 'LIST_TENANTS': {
      fakeReq.tenantId = null; // Bypass containment
      const res = createCapturingResponse();
      await superadminController.listTenants(fakeReq, res);
      return res.capture;
    }

    case 'CREATE_TENANT': {
      fakeReq.tenantId = null; // Bypass containment
      fakeReq.body = {
        name: data.name,
        subdomain: data.subdomain
      };
      const res = createCapturingResponse();
      await superadminController.createTenant(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_TENANT_STATUS': {
      fakeReq.tenantId = null; // Bypass containment
      fakeReq.params = { id: data.tenantId };
      fakeReq.body = {
        isActive: data.isActive
      };
      const res = createCapturingResponse();
      await superadminController.updateTenantStatus(fakeReq, res);
      return res.capture;
    }

    case 'LIST_ALL_USERS': {
      fakeReq.tenantId = null; // Bypass containment
      const res = createCapturingResponse();
      await superadminController.listAllUsers(fakeReq, res);
      return res.capture;
    }

    case 'UPDATE_USER_TENANT_OR_ROLE': {
      fakeReq.tenantId = null; // Bypass containment
      fakeReq.params = { id: data.userId };
      fakeReq.body = {
        tenantId: data.tenantId,
        role: data.role
      };
      const res = createCapturingResponse();
      await superadminController.updateUserTenantOrRole(fakeReq, res);
      return res.capture;
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
