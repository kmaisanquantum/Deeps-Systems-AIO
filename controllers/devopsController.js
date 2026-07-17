const db = require('../db');
const devopsService = require('../services/devopsService');

async function listNodes(req, res) {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID is required' });
    }

    const query = 'SELECT * FROM devops_nodes WHERE tenant_id = $1 ORDER BY created_at DESC';
    const { rows } = await db.query(query, [tenantId]);
    return res.status(200).json(rows);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function createNode(req, res) {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID is required' });
    }

    const { name, provider, config, branch_id } = req.body;
    if (!name || !provider) {
      return res.status(400).json({ error: 'Name and Provider are required fields' });
    }

    const query = `
      INSERT INTO devops_nodes (tenant_id, name, provider, config, branch_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const values = [tenantId, name, provider, config || {}, branch_id || null];
    const { rows } = await db.query(query, values);
    return res.status(201).json(rows[0]);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function updateNode(req, res) {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID is required' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Node ID is required' });
    }

    const { name, provider, config, status, branch_id } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(name);
    }
    if (provider !== undefined) {
      fields.push(`provider = $${idx++}`);
      values.push(provider);
    }
    if (config !== undefined) {
      fields.push(`config = $${idx++}`);
      values.push(config);
    }
    if (status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(status);
    }
    if (branch_id !== undefined) {
      fields.push(`branch_id = $${idx++}`);
      values.push(branch_id);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'At least one field to update is required' });
    }

    fields.push(`updated_at = NOW()`);
    
    // Append WHERE filter parameters
    values.push(id);
    const idIdx = idx++;
    values.push(tenantId);
    const tenantIdx = idx++;

    const query = `
      UPDATE devops_nodes
      SET ${fields.join(', ')}
      WHERE id = $${idIdx} AND tenant_id = $${tenantIdx}
      RETURNING *
    `;

    const { rows } = await db.query(query, values);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Node not found or access denied' });
    }

    return res.status(200).json(rows[0]);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function syncNode(req, res) {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID is required' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Node ID is required' });
    }

    // Check if node exists and belongs to the tenant
    const findQuery = 'SELECT * FROM devops_nodes WHERE id = $1 AND tenant_id = $2';
    const { rows: findRows } = await db.query(findQuery, [id, tenantId]);

    if (findRows.length === 0) {
      return res.status(404).json({ error: 'Node not found or access denied' });
    }

    const node = findRows[0];

    // Attempt to verify resources with provider to simulate a sync check
    const syncResult = await devopsService.listProviderResources(node.provider);
    const newStatus = syncResult.success ? 'active' : 'failed';

    const updateQuery = `
      UPDATE devops_nodes
      SET last_synced_at = NOW(),
          status = $1,
          updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3
      RETURNING *
    `;
    const { rows: updatedRows } = await db.query(updateQuery, [newStatus, id, tenantId]);

    return res.status(200).json({
      message: 'Sync completed',
      node: updatedRows[0],
      providerResponse: syncResult
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function listProviderResources(req, res) {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID is required' });
    }

    const { provider } = req.params;
    if (!provider) {
      return res.status(400).json({ error: 'Provider parameter is required' });
    }

    const result = await devopsService.listProviderResources(provider);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

module.exports = {
  listNodes,
  createNode,
  updateNode,
  syncNode,
  listProviderResources
};
