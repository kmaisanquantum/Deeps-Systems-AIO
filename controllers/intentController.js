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
async function processNaturalLanguageIntent(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId || null;
  const { text, sourceChannel = 'INTERNAL' } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required and must be a non-empty string.' });
  }
  if (!AI_ENGINE_SERVICE_URL) {
    return res.status(503).json({ error: 'AI_ENGINE_SERVICE_URL is not configured.' });
  }

  let aiResult;
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
    console.error('[intentController] AI orchestration call failed', detail);
    return res.status(502).json({ error: 'AI intent engine is unavailable.', detail });
  }

  if (!aiResult || !aiResult.action) {
    return res.status(422).json({ error: 'AI engine did not return a recognizable action.', aiResult });
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

    default:
      throw new Error(`Unrecognized or unsupported action "${action}" returned by AI engine.`);
  }
}

module.exports = { processNaturalLanguageIntent };
