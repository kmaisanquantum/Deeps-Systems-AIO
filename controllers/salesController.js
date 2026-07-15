// =====================================================================
// controllers/salesController.js
// Sales & Marketing leads and pipeline management
// =====================================================================
'use strict';

const db = require('../db');

/**
 * GET /sales/leads
 * List all sales leads/deals for the active tenant.
 */
async function listLeads(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'SELECT * FROM sales_leads WHERE tenant_id = $1 ORDER BY deal_value DESC',
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[salesController] listLeads failed', err);
    return res.status(500).json({ error: 'Failed to list sales leads.' });
  }
}

/**
 * POST /sales/leads
 * Create a new lead/deal under the active tenant.
 */
async function createLead(req, res) {
  const tenantId = req.tenantId;
  const { fullName, email, dealValue = 0, stage = 'Prospect' } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!fullName || !email) {
    return res.status(400).json({ error: 'fullName and email are required.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO sales_leads (tenant_id, full_name, email, deal_value, stage)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [tenantId, fullName, email.toLowerCase(), dealValue, stage]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[salesController] createLead failed', err);
    return res.status(500).json({ error: 'Failed to create sales lead.' });
  }
}

module.exports = {
  listLeads,
  createLead,
};
