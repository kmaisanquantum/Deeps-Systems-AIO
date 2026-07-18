// =====================================================================
// controllers/workspaceController.js
// Workspace Module: Task delegation, scheduling/appointments, and document storage.
// Strictly tenant-isolated.
// =====================================================================
'use strict';

const db = require('../db');
const eventDispatcher = require('../services/eventDispatcher');

// ---------------------------------------------------------------------
// Tasks Operations
// ---------------------------------------------------------------------

/**
 * GET /workspace/tasks
 * List all workspace tasks for the active tenant. Supports optional assigneeUserId filtering.
 */
async function listTasks(req, res) {
  const tenantId = req.tenantId;
  const assigneeUserId = req.query.assigneeUserId || req.query.assignee_user_id;

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    let result;
    if (assigneeUserId) {
      result = await db.query(
        'SELECT * FROM workspace_tasks WHERE tenant_id = $1 AND assignee_user_id = $2 ORDER BY due_date ASC, created_at DESC',
        [tenantId, assigneeUserId]
      );
    } else {
      result = await db.query(
        'SELECT * FROM workspace_tasks WHERE tenant_id = $1 ORDER BY due_date ASC, created_at DESC',
        [tenantId]
      );
    }
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[workspaceController] listTasks Error:', err);
    return res.status(500).json({ error: 'Failed to list workspace tasks.' });
  }
}

/**
 * DELETE /workspace/tasks/:id
 * Delete a workspace task.
 */
async function deleteTask(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    const result = await db.query(
      'DELETE FROM workspace_tasks WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Workspace task not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Workspace task deleted successfully.' });
  } catch (err) {
    console.error('[workspaceController] deleteTask Error:', err);
    return res.status(500).json({ error: 'Failed to delete workspace task.' });
  }
}

/**
 * POST /workspace/tasks
 * Create a new workspace task under the active tenant.
 */
async function createTask(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId || req.body.branchId || null;
  const { title, description, assigneeUserId, status = 'TODO', priority = 'NORMAL', dueDate } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }
  if (!title) {
    return res.status(400).json({ error: 'title is required.' });
  }

  // Validate status is one of: TODO, IN_PROGRESS, DONE
  const allowedStatuses = ['TODO', 'IN_PROGRESS', 'DONE'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowedStatuses.join(', ')}` });
  }

  try {
    const result = await db.query(
      `INSERT INTO workspace_tasks (tenant_id, branch_id, title, description, assignee_user_id, status, priority, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        tenantId,
        branchId,
        title,
        description || null,
        assigneeUserId || null,
        status,
        priority,
        dueDate || null,
      ]
    );
    const task = result.rows[0];
    eventDispatcher.dispatchAsync('workspace.task_created', tenantId, { task });
    return res.status(201).json(task);
  } catch (err) {
    console.error('[workspaceController] createTask Error:', err);
    return res.status(500).json({ error: 'Failed to create workspace task.' });
  }
}

/**
 * PATCH /workspace/tasks/:id/status
 * Update status of an existing workspace task.
 */
async function updateTaskStatus(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { status } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }
  if (!status) {
    return res.status(400).json({ error: 'status is required.' });
  }

  const allowedStatuses = ['TODO', 'IN_PROGRESS', 'DONE'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowedStatuses.join(', ')}` });
  }

  try {
    const result = await db.query(
      `UPDATE workspace_tasks
          SET status = $1, updated_at = now()
        WHERE id = $2 AND tenant_id = $3
        RETURNING *`,
      [status, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Workspace task not found or not in tenant scope.' });
    }

    const task = result.rows[0];
    eventDispatcher.dispatchAsync('workspace.task_updated', tenantId, { task });

    return res.status(200).json(task);
  } catch (err) {
    console.error('[workspaceController] updateTaskStatus Error:', err);
    return res.status(500).json({ error: 'Failed to update workspace task status.' });
  }
}

// ---------------------------------------------------------------------
// Events Operations
// ---------------------------------------------------------------------

/**
 * GET /workspace/events
 * List all workspace events/appointments for the active tenant.
 */
async function listEvents(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    const result = await db.query(
      'SELECT * FROM workspace_events WHERE tenant_id = $1 ORDER BY starts_at ASC',
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[workspaceController] listEvents Error:', err);
    return res.status(500).json({ error: 'Failed to list workspace events.' });
  }
}

/**
 * POST /workspace/events
 * Create a new workspace event under the active tenant.
 */
async function createEvent(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId || req.body.branchId || null;
  const { title, description, startsAt, endsAt, location, organizerUserId } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }
  if (!title) {
    return res.status(400).json({ error: 'title is required.' });
  }
  if (!startsAt) {
    return res.status(400).json({ error: 'startsAt is required.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO workspace_events (tenant_id, branch_id, title, description, starts_at, ends_at, location, organizer_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        tenantId,
        branchId,
        title,
        description || null,
        startsAt,
        endsAt || null,
        location || null,
        organizerUserId || null,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[workspaceController] createEvent Error:', err);
    return res.status(500).json({ error: 'Failed to create workspace event.' });
  }
}

// ---------------------------------------------------------------------
// Documents Operations
// ---------------------------------------------------------------------

/**
 * GET /workspace/documents
 * List all workspace documents for the active tenant.
 */
async function listDocuments(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    const result = await db.query(
      'SELECT * FROM workspace_documents WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[workspaceController] listDocuments Error:', err);
    return res.status(500).json({ error: 'Failed to list workspace documents.' });
  }
}

/**
 * POST /workspace/documents
 * Create a new workspace document under the active tenant.
 */
async function createDocument(req, res) {
  const tenantId = req.tenantId;
  const branchId = req.branchId || req.body.branchId || null;
  const { title, category, url, content, status = 'DRAFT', notes } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }
  if (!title) {
    return res.status(400).json({ error: 'title is required.' });
  }

  const allowedStatuses = ['DRAFT', 'FINAL', 'SIGNED'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowedStatuses.join(', ')}` });
  }

  try {
    const result = await db.query(
      `INSERT INTO workspace_documents (tenant_id, branch_id, title, category, url, content, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        tenantId,
        branchId,
        title,
        category || null,
        url || null,
        content || null,
        status,
        notes || null,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[workspaceController] createDocument Error:', err);
    return res.status(500).json({ error: 'Failed to create workspace document.' });
  }
}

/**
 * PATCH /workspace/events/:id
 * Update workspace event.
 */
async function updateEvent(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { title, description, startsAt, endsAt, location, organizerUserId } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    const result = await db.query(
      `UPDATE workspace_events
          SET title = COALESCE($1, title),
              description = COALESCE($2, description),
              starts_at = COALESCE($3, starts_at),
              ends_at = COALESCE($4, ends_at),
              location = COALESCE($5, location),
              organizer_user_id = COALESCE($6, organizer_user_id),
              updated_at = now()
        WHERE id = $7 AND tenant_id = $8
        RETURNING *`,
      [title, description, startsAt, endsAt, location, organizerUserId, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Workspace event not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[workspaceController] updateEvent Error:', err);
    return res.status(500).json({ error: 'Failed to update workspace event.' });
  }
}

/**
 * DELETE /workspace/events/:id
 * Delete workspace event.
 */
async function deleteEvent(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    const result = await db.query(
      'DELETE FROM workspace_events WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Workspace event not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Workspace event deleted successfully.' });
  } catch (err) {
    console.error('[workspaceController] deleteEvent Error:', err);
    return res.status(500).json({ error: 'Failed to delete workspace event.' });
  }
}

/**
 * PATCH /workspace/documents/:id
 * Update workspace document.
 */
async function updateDocument(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { title, category, url, content, status, notes } = req.body || {};

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  if (status) {
    const allowedStatuses = ['DRAFT', 'FINAL', 'SIGNED'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowedStatuses.join(', ')}` });
    }
  }

  try {
    const result = await db.query(
      `UPDATE workspace_documents
          SET title = COALESCE($1, title),
              category = COALESCE($2, category),
              url = COALESCE($3, url),
              content = COALESCE($4, content),
              status = COALESCE($5, status),
              notes = COALESCE($6, notes),
              updated_at = now()
        WHERE id = $7 AND tenant_id = $8
        RETURNING *`,
      [title, category, url, content, status, notes, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Workspace document not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[workspaceController] updateDocument Error:', err);
    return res.status(500).json({ error: 'Failed to update workspace document.' });
  }
}

/**
 * DELETE /workspace/documents/:id
 * Delete workspace document.
 */
async function deleteDocument(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context is required.' });
  }

  try {
    const result = await db.query(
      'DELETE FROM workspace_documents WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Workspace document not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Workspace document deleted successfully.' });
  } catch (err) {
    console.error('[workspaceController] deleteDocument Error:', err);
    return res.status(500).json({ error: 'Failed to delete workspace document.' });
  }
}

module.exports = {
  listTasks,
  createTask,
  updateTaskStatus,
  deleteTask,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  listDocuments,
  createDocument,
  updateDocument,
  deleteDocument,
};
