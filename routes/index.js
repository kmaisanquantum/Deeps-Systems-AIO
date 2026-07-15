// =====================================================================
// routes/index.js — central Express router wiring
// =====================================================================
'use strict';

const express = require('express');
const router = express.Router();

const { requireTenant } = require('../middleware/tenantResolver');

const authController = require('../controllers/authController');
const communicationController = require('../controllers/communicationController');
const financeController = require('../controllers/financeController');
const bankingController = require('../controllers/bankingController');
const hrController = require('../controllers/hrController');
const intentController = require('../controllers/intentController');
const storeController = require('../controllers/storeController');
const salesController = require('../controllers/salesController');
const logisticsService = require('../services/logisticsService');

// -----------------------------------------------------------------
// Authentication
// -----------------------------------------------------------------
router.post('/api/auth/register', authController.register);
router.post('/api/auth/login', authController.login);
router.get('/api/auth/me', authController.getMe);

// -----------------------------------------------------------------
// Omnichannel messaging
// -----------------------------------------------------------------
router.get('/webhooks/whatsapp', communicationController.verifyWhatsAppWebhook);
router.post('/webhooks/whatsapp', communicationController.handleWhatsAppWebhook);
router.post('/webhooks/email-inbound', requireTenant, communicationController.handleInboundEmailHook);
router.post('/communications/dispatch', requireTenant, communicationController.dispatchOutboundMessage);

// -----------------------------------------------------------------
// Finance / ledger
// -----------------------------------------------------------------
router.get('/finance/transactions', requireTenant, financeController.listTransactions);
router.post('/finance/transactions', requireTenant, financeController.logTransaction);
router.post('/finance/transactions/manual', requireTenant, financeController.logManualTransaction);
router.post('/finance/webhooks/invoice-reconciliation', requireTenant, financeController.reconcileInvoicePayment);

// -----------------------------------------------------------------
// Regional banking gateways
// -----------------------------------------------------------------
router.post('/banking/bsp/checkout', requireTenant, bankingController.initiateBSPPayCheck);
router.post('/banking/kina/webhook', requireTenant, bankingController.handleKinaIPGWebhook);
router.post('/banking/manual/reconcile', requireTenant, bankingController.reconcileManualTransfer);

// -----------------------------------------------------------------
// HR
// -----------------------------------------------------------------
router.get('/hr/profiles', requireTenant, hrController.listProfiles);
router.post('/hr/profiles', requireTenant, hrController.createProfile);
router.patch('/hr/profiles/:id/status', requireTenant, hrController.updateProfileStatus);

// -----------------------------------------------------------------
// Website & Online Store
// -----------------------------------------------------------------
router.get('/store/items', requireTenant, storeController.listItems);
router.post('/store/items', requireTenant, storeController.createItem);

// -----------------------------------------------------------------
// Sales & Marketing
// -----------------------------------------------------------------
router.get('/sales/leads', requireTenant, salesController.listLeads);
router.post('/sales/leads', requireTenant, salesController.createLead);

// -----------------------------------------------------------------
// Logistics
// -----------------------------------------------------------------
router.post('/logistics/shipments', requireTenant, async (req, res) => {
  try {
    const shipment = await logisticsService.createShipment({
      tenantId: req.tenantId,
      branchId: req.branchId || req.body.branchId,
      carrier: req.body.carrier,
      originAddress: req.body.originAddress,
      destinationAddress: req.body.destinationAddress,
      weightKg: req.body.weightKg,
    });
    res.status(201).json(shipment);
  } catch (err) {
    console.error('[routes] create shipment failed', err);
    res.status(502).json({ error: 'Failed to create shipment.', detail: err.message });
  }
});

router.get('/logistics/shipments/:id/tracking', requireTenant, async (req, res) => {
  try {
    const shipment = await logisticsService.fetchTrackingStatus(req.params.id);
    res.status(200).json(shipment);
  } catch (err) {
    console.error('[routes] fetch tracking failed', err);
    res.status(502).json({ error: 'Failed to fetch tracking status.', detail: err.message });
  }
});

// -----------------------------------------------------------------
// Talk-to-Options AI intent engine
// -----------------------------------------------------------------
router.post('/intent/process', requireTenant, intentController.processNaturalLanguageIntent);

// -----------------------------------------------------------------
// Health check (unscoped — used by Coolify/Docker health probes)
// -----------------------------------------------------------------
router.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

module.exports = router;
