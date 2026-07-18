// =====================================================================
// controllers/storeController.js
// Website & Online Store inventory and catalog management
// =====================================================================
'use strict';

const axios = require('axios');
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

/**
 * PATCH /store/items/:id
 * Update catalog item.
 */
async function updateItem(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { title, price, description, inventoryCount, inventory_count } = req.body || {};
  const targetInvCount = inventoryCount !== undefined ? inventoryCount : inventory_count;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `UPDATE store_items
          SET title = COALESCE($1, title),
              price = COALESCE($2, price),
              description = COALESCE($3, description),
              inventory_count = COALESCE($4, inventory_count),
              updated_at = now()
        WHERE id = $5 AND tenant_id = $6
        RETURNING *`,
      [title, price, description, targetInvCount, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Item not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[storeController] updateItem error:', err);
    return res.status(500).json({ error: 'Failed to update catalog item.' });
  }
}

/**
 * DELETE /store/items/:id
 * Delete catalog item.
 */
async function deleteItem(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM store_items WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Item not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Item deleted successfully.' });
  } catch (err) {
    console.error('[storeController] deleteItem error:', err);
    return res.status(500).json({ error: 'Failed to delete catalog item.' });
  }
}

/**
 * GET /store/pages
 * List CMS pages for the active tenant.
 */
async function listPages(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'SELECT * FROM store_pages WHERE tenant_id = $1 ORDER BY title ASC',
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[storeController] listPages error:', err);
    return res.status(500).json({ error: 'Failed to list CMS pages.' });
  }
}

/**
 * POST /store/pages
 * Create a new CMS page.
 */
async function createPage(req, res) {
  const tenantId = req.tenantId;
  const { title, slug, content, isPublished = true, is_published } = req.body || {};
  const targetPublished = isPublished !== undefined ? isPublished : is_published;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!title || !slug) return res.status(400).json({ error: 'title and slug are required.' });

  try {
    const result = await db.query(
      `INSERT INTO store_pages (tenant_id, title, slug, content, is_published)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [tenantId, title, slug, content || null, targetPublished !== false]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[storeController] createPage error:', err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Page with this slug already exists under this tenant.' });
    }
    return res.status(500).json({ error: 'Failed to create CMS page.' });
  }
}

/**
 * PATCH /store/pages/:id
 * Update CMS page.
 */
async function updatePage(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { title, slug, content, isPublished, is_published } = req.body || {};
  const targetPublished = isPublished !== undefined ? isPublished : is_published;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `UPDATE store_pages
          SET title = COALESCE($1, title),
              slug = COALESCE($2, slug),
              content = COALESCE($3, content),
              is_published = COALESCE($4, is_published),
              updated_at = now()
        WHERE id = $5 AND tenant_id = $6
        RETURNING *`,
      [title, slug, content, targetPublished, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Page not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[storeController] updatePage error:', err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Page with this slug already exists under this tenant.' });
    }
    return res.status(500).json({ error: 'Failed to update CMS page.' });
  }
}

/**
 * DELETE /store/pages/:id
 * Delete CMS page.
 */
async function deletePage(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM store_pages WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Page not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Page deleted successfully.' });
  } catch (err) {
    console.error('[storeController] deletePage error:', err);
    return res.status(500).json({ error: 'Failed to delete CMS page.' });
  }
}

/**
 * GET /store/checkouts
 * List history of store checkout records.
 */
async function listCheckouts(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'SELECT * FROM store_checkouts WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[storeController] listCheckouts error:', err);
    return res.status(500).json({ error: 'Failed to list checkouts.' });
  }
}

/**
 * POST /store/checkouts
 * Record a purchase and atomically adjust inventory.
 */
async function createCheckout(req, res) {
  const tenantId = req.tenantId;
  const { amount, currency = 'PGK', email, items } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (amount == null || amount < 0) return res.status(400).json({ error: 'Valid amount is required.' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. Decrement inventory for each item in the map
    if (items && Array.isArray(items)) {
      for (const cartItem of items) {
        const { itemId, quantity = 1 } = cartItem;
        if (!itemId) continue;

        // Verify item belongs to this tenant and has enough inventory
        // The DB constraint CHECK (inventory_count >= 0) will naturally throw an exception if inventory drops below zero.
        const updateRes = await client.query(
          `UPDATE store_items
              SET inventory_count = inventory_count - $1,
                  updated_at = now()
            WHERE id = $2 AND tenant_id = $3
            RETURNING id, title, inventory_count`,
          [quantity, itemId, tenantId]
        );

        if (updateRes.rowCount === 0) {
          throw new Error('ITEM_NOT_FOUND_OR_OUT_OF_SCOPE');
        }
      }
    }

    // 2. Insert checkout record
    const checkoutResult = await client.query(
      `INSERT INTO store_checkouts (tenant_id, amount, currency, email, status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       RETURNING *`,
      [tenantId, amount, currency, email || null]
    );

    await client.query('COMMIT');
    return res.status(201).json(checkoutResult.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[storeController] createCheckout error:', err);

    if (err.message === 'ITEM_NOT_FOUND_OR_OUT_OF_SCOPE') {
      return res.status(400).json({ error: 'One or more items not found or out of scope.' });
    }

    // Trap Postgres check-constraint violation or any error suggesting negative inventory
    if (err.code === '23514' || (err.message && err.message.toLowerCase().includes('inventory_count'))) {
      return res.status(400).json({ error: 'Insufficient stock available for this transaction.' });
    }

    return res.status(500).json({ error: 'Failed to create checkout transaction.' });
  } finally {
    client.release();
  }
}

/**
 * PATCH /store/checkouts/:id/status
 * Transition checkout status.
 */
async function updateCheckoutStatus(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { status } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!status) return res.status(400).json({ error: 'status is required.' });

  try {
    const result = await db.query(
      `UPDATE store_checkouts
          SET status = $1, updated_at = now()
        WHERE id = $2 AND tenant_id = $3
        RETURNING *`,
      [status, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Checkout not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[storeController] updateCheckoutStatus error:', err);
    return res.status(500).json({ error: 'Failed to update checkout status.' });
  }
}

/**
 * GET /api/store/sites
 * List all connected sites for the active tenant.
 */
async function listSites(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'SELECT * FROM connected_sites WHERE tenant_id = $1 ORDER BY label ASC',
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[storeController] listSites failed', err);
    return res.status(500).json({ error: 'Failed to list connected sites.' });
  }
}

/**
 * POST /api/store/sites
 * Create a new connected site under the active tenant.
 */
async function createSite(req, res) {
  const tenantId = req.tenantId;
  const { label, url } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!label || !url) return res.status(400).json({ error: 'label and url are required.' });

  try {
    const result = await db.query(
      `INSERT INTO connected_sites (tenant_id, label, url)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [tenantId, label, url]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[storeController] createSite failed', err);
    return res.status(500).json({ error: 'Failed to create connected site.' });
  }
}

/**
 * DELETE /api/store/sites/:id
 * Delete a connected site under the active tenant.
 */
async function deleteSite(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM connected_sites WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Site not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Site deleted successfully.' });
  } catch (err) {
    console.error('[storeController] deleteSite error:', err);
    return res.status(500).json({ error: 'Failed to delete connected site.' });
  }
}

/**
 * POST /api/store/sites/:id/check
 * Ping the site and update status.
 */
async function checkSite(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const siteCheck = await db.query(
      'SELECT id, url FROM connected_sites WHERE id = $1 AND tenant_id = $2',
      [id, tenantId]
    );

    if (siteCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Site not found or not in tenant scope.' });
    }

    const site = siteCheck.rows[0];
    let status = 'offline';

    try {
      // Primary Check (/healthz Probe)
      let baseUrl = site.url || '';
      if (baseUrl.endsWith('/')) {
        baseUrl = baseUrl.slice(0, -1);
      }
      const healthUrl = `${baseUrl}/healthz`;

      const response = await axios.get(healthUrl, {
        timeout: 5000,
        validateStatus: () => true
      });

      let isHealthy = false;
      if (response.status === 200 && response.data !== null && response.data !== undefined) {
        const data = response.data;
        if (typeof data === 'object') {
          if (data.status === 'ok' || data.ok === true || data.status === 'healthy') {
            isHealthy = true;
          } else {
            const stringified = JSON.stringify(data).toLowerCase();
            if (stringified.includes('ok') || stringified.includes('healthy')) {
              isHealthy = true;
            }
          }
        } else {
          const lowerData = String(data).toLowerCase();
          if (lowerData.includes('ok') || lowerData.includes('healthy')) {
            isHealthy = true;
          }
        }
      }

      if (isHealthy) {
        status = 'online';
      } else {
        // Secondary Check (Soft Fallback)
        const fallbackResponse = await axios.get(site.url, {
          timeout: 5000,
          validateStatus: () => true
        });
        if (fallbackResponse.status >= 200 && fallbackResponse.status < 400) {
          status = 'online';
        }
      }
    } catch (axiosErr) {
      console.warn(`[storeController] checkSite ping failed for ${site.url}:`, axiosErr.message);
      status = 'offline';
    }

    const updateResult = await db.query(
      `UPDATE connected_sites
          SET last_status = $1,
              last_checked_at = now(),
              updated_at = now()
        WHERE id = $2 AND tenant_id = $3
        RETURNING *`,
      [status, id, tenantId]
    );

    return res.status(200).json(updateResult.rows[0]);
  } catch (err) {
    console.error('[storeController] checkSite error:', err);
    return res.status(500).json({ error: 'Failed to check connected site.' });
  }
}

module.exports = {
  listItems,
  createItem,
  updateItem,
  deleteItem,
  listPages,
  createPage,
  updatePage,
  deletePage,
  listCheckouts,
  createCheckout,
  updateCheckoutStatus,
  listSites,
  createSite,
  deleteSite,
  checkSite,
};
