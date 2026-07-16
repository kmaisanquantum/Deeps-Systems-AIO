// =====================================================================
// routes/index.js — central Express router wiring
// =====================================================================
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');

const { requireTenant, requireAuth, requireRole } = require('../middleware/tenantResolver');

const authController = require('../controllers/authController');
const communicationController = require('../controllers/communicationController');
const financeController = require('../controllers/financeController');
const bankingController = require('../controllers/bankingController');
const hrController = require('../controllers/hrController');
const intentController = require('../controllers/intentController');
const storeController = require('../controllers/storeController');
const salesController = require('../controllers/salesController');
const workspaceController = require('../controllers/workspaceController');
const adminController = require('../controllers/adminController');
const superadminController = require('../controllers/superadminController');
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
router.get('/finance/summary', requireTenant, financeController.getFinanceSummary);

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
router.delete('/hr/profiles/:id', requireTenant, hrController.deleteProfile);

// -----------------------------------------------------------------
// Website & Online Store
// -----------------------------------------------------------------
router.get('/store/items', requireTenant, storeController.listItems);
router.post('/store/items', requireTenant, storeController.createItem);
router.patch('/store/items/:id', requireTenant, storeController.updateItem);
router.delete('/store/items/:id', requireTenant, storeController.deleteItem);

router.get('/store/pages', requireTenant, storeController.listPages);
router.post('/store/pages', requireTenant, storeController.createPage);
router.patch('/store/pages/:id', requireTenant, storeController.updatePage);
router.delete('/store/pages/:id', requireTenant, storeController.deletePage);

router.get('/store/checkouts', requireTenant, storeController.listCheckouts);
router.post('/store/checkouts', requireTenant, storeController.createCheckout);
router.patch('/store/checkouts/:id/status', requireTenant, storeController.updateCheckoutStatus);

// -----------------------------------------------------------------
// Sales & Marketing
// -----------------------------------------------------------------
router.get('/sales/leads', requireTenant, salesController.listLeads);
router.post('/sales/leads', requireTenant, salesController.createLead);
router.patch('/sales/leads/:id/stage', requireTenant, salesController.updateLeadStage);
router.patch('/sales/leads/:id', requireTenant, salesController.updateLead);
router.delete('/sales/leads/:id', requireTenant, salesController.deleteLead);

// -----------------------------------------------------------------
// Workspace (virtual office)
// -----------------------------------------------------------------
router.get('/workspace/tasks', requireTenant, workspaceController.listTasks);
router.post('/workspace/tasks', requireTenant, workspaceController.createTask);
router.patch('/workspace/tasks/:id/status', requireTenant, workspaceController.updateTaskStatus);
router.delete('/workspace/tasks/:id', requireTenant, workspaceController.deleteTask);

router.get('/workspace/events', requireTenant, workspaceController.listEvents);
router.post('/workspace/events', requireTenant, workspaceController.createEvent);
router.patch('/workspace/events/:id', requireTenant, workspaceController.updateEvent);
router.delete('/workspace/events/:id', requireTenant, workspaceController.deleteEvent);

router.get('/workspace/documents', requireTenant, workspaceController.listDocuments);
router.post('/workspace/documents', requireTenant, workspaceController.createDocument);
router.patch('/workspace/documents/:id', requireTenant, workspaceController.updateDocument);
router.delete('/workspace/documents/:id', requireTenant, workspaceController.deleteDocument);

// -----------------------------------------------------------------
// Admin / user management
// -----------------------------------------------------------------
router.get('/admin/users', requireTenant, requireAuth, requireRole('admin'), adminController.listUsers);
router.post('/admin/users', requireTenant, requireAuth, requireRole('admin'), adminController.createUser);
router.patch('/admin/users/:id', requireTenant, requireAuth, requireRole('admin'), adminController.updateUserDetails);
router.delete('/admin/users/:id', requireTenant, requireAuth, requireRole('admin'), adminController.deleteUser);
router.patch('/admin/users/:id/role', requireTenant, requireAuth, requireRole('admin'), adminController.updateUserRole);
router.patch('/admin/users/:id/password', requireTenant, requireAuth, requireRole('admin'), adminController.resetUserPassword);
router.patch('/admin/users/:id/status', requireTenant, requireAuth, requireRole('admin'), adminController.updateUserStatus);
router.patch('/admin/users/:id/branch', requireTenant, requireAuth, requireRole('admin'), adminController.assignUserBranch);

// Branches CRUD
router.get('/admin/branches', requireTenant, requireAuth, requireRole('admin'), adminController.listBranches);
router.post('/admin/branches', requireTenant, requireAuth, requireRole('admin'), adminController.createBranch);
router.patch('/admin/branches/:id', requireTenant, requireAuth, requireRole('admin'), adminController.updateBranch);
router.delete('/admin/branches/:id', requireTenant, requireAuth, requireRole('admin'), adminController.deleteBranch);

// Tenant configuration
router.get('/admin/tenant', requireTenant, requireAuth, requireRole('admin'), adminController.getTenant);
router.patch('/admin/tenant', requireTenant, requireAuth, requireRole('admin'), adminController.updateTenant);

// -----------------------------------------------------------------
// Superadmin operations (Centralized and platform-wide)
// -----------------------------------------------------------------
router.get('/api/superadmin/tenants', requireAuth, requireRole('superadmin'), superadminController.listTenants);
router.post('/api/superadmin/tenants', requireAuth, requireRole('superadmin'), superadminController.createTenant);
router.patch('/api/superadmin/tenants/:id', requireAuth, requireRole('superadmin'), superadminController.updateTenantStatus);
router.get('/api/superadmin/users', requireAuth, requireRole('superadmin'), superadminController.listAllUsers);
router.patch('/api/superadmin/users/:id', requireAuth, requireRole('superadmin'), superadminController.updateUserTenantOrRole);

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

router.get('/logistics/shipments', requireTenant, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM logistics_shipments WHERE tenant_id = $1 ORDER BY created_at DESC',
      [req.tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[routes] list shipments failed error:', err);
    return res.status(500).json({ error: 'Failed to list shipments.' });
  }
});

router.patch('/logistics/shipments/:id/status', requireTenant, async (req, res) => {
  const { status } = req.body || {};
  if (!status) {
    return res.status(400).json({ error: 'status is required.' });
  }

  const allowedStatuses = ['PENDING', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'FAILED'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowedStatuses.join(', ')}` });
  }

  try {
    const result = await db.query(
      `UPDATE logistics_shipments
          SET shipping_status = $1, updated_at = now()
        WHERE id = $2 AND tenant_id = $3
        RETURNING *`,
      [status, req.params.id, req.tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Shipment not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[routes] update shipment status failed error:', err);
    return res.status(500).json({ error: 'Failed to update shipment status.' });
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
