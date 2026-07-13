// =====================================================================
// controllers/storeController.js
// Website & Online Store inventory and catalog management
// =====================================================================
'use strict';

const db = require('../db');

/**
 * GET /store/items
 * List all catalog items for the active tenant.
 */
async function listItems(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'SELECT * FROM store_items WHERE tenant_id = $1 ORDER BY title ASC',
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[storeController] listItems failed', err);
    return res.status(500).json({ error: 'Failed to list storefront items.' });
  }
}

/**
 * POST /store/items
 * Create a new catalog item under the active tenant.
 */
async function createItem(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId || null;
  const { title, price, description, inventoryCount = 0 } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!title) return res.status(400).json({ error: 'title is required.' });

  try {
    const result = await db.query(
      `INSERT INTO store_items (tenant_id, branch_id, title, price, description, inventory_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tenantId, branchId, title, price || 0, description || null, inventoryCount]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[storeController] createItem failed', err);
    return res.status(500).json({ error: 'Failed to create storefront item.' });
  }
}

module.exports = {
  listItems,
  createItem,
};
