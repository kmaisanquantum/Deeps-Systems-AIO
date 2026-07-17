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
    const syncResult = await devopsService.listProviderResources(node.provider, tenantId);
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

    const result = await devopsService.listProviderResources(provider, tenantId);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function listCredentials(req, res) {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID is required' });
    }

    const query = 'SELECT provider, base_url FROM devops_credentials WHERE tenant_id = $1';
    const { rows } = await db.query(query, [tenantId]);

    const supportedProviders = ['github', 'vultr', 'hostgator', 'coolify'];
    const linkedMap = {};
    rows.forEach(r => {
      linkedMap[r.provider.toLowerCase()] = r.base_url;
    });

    const credentials = supportedProviders.map(prov => {
      const linked = Object.prototype.hasOwnProperty.call(linkedMap, prov);
      return {
        provider: prov,
        base_url: linked ? linkedMap[prov] : null,
        linked
      };
    });

    return res.status(200).json(credentials);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function saveCredential(req, res) {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID is required' });
    }

    const key = process.env.CREDENTIALS_ENCRYPTION_KEY;
    if (!key) {
      return res.status(503).json({ error: 'Credentials encryption key is unconfigured on the server' });
    }

    const { provider, secret, baseUrl } = req.body;
    if (!provider || !secret) {
      return res.status(400).json({ error: 'Provider and secret are required fields' });
    }

    const provLower = provider.toLowerCase();
    const supportedProviders = ['github', 'vultr', 'hostgator', 'coolify'];
    if (!supportedProviders.includes(provLower)) {
      return res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }

    const query = `
      INSERT INTO devops_credentials (tenant_id, provider, secret_encrypted, base_url)
      VALUES ($1, $2, pgp_sym_encrypt($3, $4), $5)
      ON CONFLICT (tenant_id, provider) DO UPDATE
      SET secret_encrypted = pgp_sym_encrypt($3, $4),
          base_url = $5,
          updated_at = NOW()
      RETURNING provider, base_url
    `;
    const { rows } = await db.query(query, [tenantId, provLower, secret, key, baseUrl || null]);

    return res.status(200).json({
      message: 'Credential linked successfully',
      credential: {
        provider: rows[0].provider,
        base_url: rows[0].base_url,
        linked: true
      }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function deleteCredential(req, res) {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID is required' });
    }

    const { provider } = req.params;
    if (!provider) {
      return res.status(400).json({ error: 'Provider is required' });
    }

    const provLower = provider.toLowerCase();
    const query = 'DELETE FROM devops_credentials WHERE tenant_id = $1 AND LOWER(provider) = $2 RETURNING *';
    const { rowCount } = await db.query(query, [tenantId, provLower]);

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Credential not found' });
    }

    return res.status(200).json({ message: 'Credential unlinked successfully' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function listPipelines(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `SELECT p.*, n.name AS node_name
         FROM devops_pipelines p
         LEFT JOIN devops_nodes n ON p.node_id = n.id
        WHERE p.tenant_id = $1
        ORDER BY p.created_at DESC`,
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[devopsController] listPipelines failed', err);
    return res.status(500).json({ error: 'Failed to list pipelines.' });
  }
}

async function createPipeline(req, res) {
  const tenantId = req.tenantId;
  const { name, node_id, branch_id } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!name) return res.status(400).json({ error: 'name is required.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO devops_pipelines (tenant_id, node_id, branch_id, name)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, node_id || null, branch_id || null, name]
    );
    const pipeline = result.rows[0];

    // Initial event log
    await client.query(
      `INSERT INTO devops_pipeline_events (tenant_id, pipeline_id, stage, note)
       VALUES ($1, $2, 'PLAN', 'Pipeline created')`,
      [tenantId, pipeline.id]
    );

    await client.query('COMMIT');
    return res.status(201).json(pipeline);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[devopsController] createPipeline failed', err);
    return res.status(500).json({ error: 'Failed to create pipeline.' });
  } finally {
    client.release();
  }
}

async function deletePipeline(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM devops_pipelines WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Pipeline not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Pipeline deleted successfully.' });
  } catch (err) {
    console.error('[devopsController] deletePipeline failed', err);
    return res.status(500).json({ error: 'Failed to delete pipeline.' });
  }
}

async function listPipelineEvents(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `SELECT * FROM devops_pipeline_events
        WHERE pipeline_id = $1 AND tenant_id = $2
        ORDER BY created_at DESC`,
      [id, tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[devopsController] listPipelineEvents failed', err);
    return res.status(500).json({ error: 'Failed to list pipeline events.' });
  }
}

async function transitionStage(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { stage, note } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!stage) return res.status(400).json({ error: 'stage is required.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch current pipeline details
    const pipelineRes = await client.query(
      'SELECT * FROM devops_pipelines WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, tenantId]
    );

    if (pipelineRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pipeline not found or not in tenant scope.' });
    }

    const pipeline = pipelineRes.rows[0];

    // Increment cycle count if moving back to PLAN from any other stage
    const isLoopBack = (stage === 'PLAN' && pipeline.current_stage !== 'PLAN');
    const cycleIncrement = isLoopBack ? 1 : 0;

    // 2. Update pipeline current stage and loop count
    const updatedRes = await client.query(
      `UPDATE devops_pipelines
          SET current_stage = $1,
              cycle_count = cycle_count + $2,
              updated_at = NOW()
        WHERE id = $3 AND tenant_id = $4
        RETURNING *`,
      [stage, cycleIncrement, id, tenantId]
    );
    const updatedPipeline = updatedRes.rows[0];

    // 3. Log the stage transition event
    await client.query(
      `INSERT INTO devops_pipeline_events (tenant_id, pipeline_id, stage, note)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, id, stage, note || `Transitioned to ${stage}`]
    );

    await client.query('COMMIT');

    return res.status(200).json(updatedPipeline);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[devopsController] transitionStage failed', err);
    return res.status(500).json({ error: 'Failed to transition pipeline stage.' });
  } finally {
    client.release();
  }
}

async function deleteNode(req, res) {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;

    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant ID is required' });
    }
    if (!id) {
      return res.status(400).json({ success: false, message: 'Node ID is required' });
    }

    const query = 'DELETE FROM devops_nodes WHERE id = $1 AND tenant_id = $2 RETURNING *';
    const { rows, rowCount } = await db.query(query, [id, tenantId]);

    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Node not found or unauthorized' });
    }

    return res.status(200).json({ success: true, message: 'DevOps Node permanently removed', node: rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = {
  listNodes,
  createNode,
  updateNode,
  syncNode,
  listProviderResources,
  listCredentials,
  saveCredential,
  deleteCredential,
  listPipelines,
  createPipeline,
  deletePipeline,
  listPipelineEvents,
  transitionStage,
  deleteNode
};
