// =====================================================================
// controllers/salesController.js
// Sales & Marketing leads and pipeline management
// =====================================================================
'use strict';

const db = require('../db');
const eventDispatcher = require('../services/eventDispatcher');

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
    const lead = result.rows[0];
    eventDispatcher.dispatchAsync('sales.lead_created', tenantId, { lead });
    if (lead.stage === 'Won') {
      eventDispatcher.dispatchAsync('sales.lead_won', tenantId, { lead });
    }
    return res.status(201).json(lead);
  } catch (err) {
    console.error('[salesController] createLead failed', err);
    return res.status(500).json({ error: 'Failed to create sales lead.' });
  }
}

/**
 * PATCH /sales/leads/:id/stage
 * Transition lead pipeline stage.
 */
async function updateLeadStage(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { stage } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!stage) return res.status(400).json({ error: 'stage is required.' });

  const allowedStages = ['Prospect', 'Contacted', 'Qualified', 'Won', 'Lost'];
  if (!allowedStages.includes(stage)) {
    return res.status(400).json({ error: `stage must be one of: ${allowedStages.join(', ')}` });
  }

  try {
    const result = await db.query(
      `UPDATE sales_leads
          SET stage = $1, updated_at = now()
        WHERE id = $2 AND tenant_id = $3
        RETURNING *`,
      [stage, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Lead not found or not in tenant scope.' });
    }

    const lead = result.rows[0];
    eventDispatcher.dispatchAsync('sales.lead_updated', tenantId, { lead });
    if (lead.stage === 'Won') {
      eventDispatcher.dispatchAsync('sales.lead_won', tenantId, { lead });
    }

    return res.status(200).json(lead);
  } catch (err) {
    console.error('[salesController] updateLeadStage error:', err);
    return res.status(500).json({ error: 'Failed to update lead stage.' });
  }
}

/**
 * PATCH /sales/leads/:id
 * Update full_name, email, deal_value of a lead.
 */
async function updateLead(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { full_name, email, deal_value, stage } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  const cleansedEmail = email ? email.toLowerCase().trim() : null;

  if (stage) {
    const allowedStages = ['Prospect', 'Contacted', 'Qualified', 'Won', 'Lost'];
    if (!allowedStages.includes(stage)) {
      return res.status(400).json({ error: `stage must be one of: ${allowedStages.join(', ')}` });
    }
  }

  try {
    const result = await db.query(
      `UPDATE sales_leads
          SET full_name = COALESCE($1, full_name),
              email = COALESCE($2, email),
              deal_value = COALESCE($3, deal_value),
              stage = COALESCE($4, stage),
              updated_at = now()
        WHERE id = $5 AND tenant_id = $6
        RETURNING *`,
      [full_name, cleansedEmail, deal_value, stage, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Lead not found or not in tenant scope.' });
    }

    const lead = result.rows[0];
    eventDispatcher.dispatchAsync('sales.lead_updated', tenantId, { lead });
    if (lead.stage === 'Won') {
      eventDispatcher.dispatchAsync('sales.lead_won', tenantId, { lead });
    }

    return res.status(200).json(lead);
  } catch (err) {
    console.error('[salesController] updateLead error:', err);
    return res.status(500).json({ error: 'Failed to update lead.' });
  }
}

/**
 * DELETE /sales/leads/:id
 * Delete a lead safely.
 */
async function deleteLead(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM sales_leads WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Lead not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Lead deleted successfully.' });
  } catch (err) {
    console.error('[salesController] deleteLead error:', err);
    return res.status(500).json({ error: 'Failed to delete lead.' });
  }
}

module.exports = {
  listLeads,
  createLead,
  updateLeadStage,
  updateLead,
  deleteLead,
};
