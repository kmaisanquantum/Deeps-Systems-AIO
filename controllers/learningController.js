// =====================================================================
// controllers/learningController.js
// Learning Pathway: Learning Resources and Study Schedules
// =====================================================================
'use strict';

const db = require('../db');

// ---------------------------------------------------------------------
// LEARNING RESOURCES
// ---------------------------------------------------------------------

/**
 * GET /learning/resources
 * List all learning resources for the active tenant.
 */
async function listResources(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'SELECT * FROM learning_resources WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[learningController] listResources failed', err);
    return res.status(500).json({ error: 'Failed to list learning resources.' });
  }
}

/**
 * POST /learning/resources
 * Create a new learning resource under the active tenant.
 */
async function createResource(req, res) {
  const tenantId = req.tenantId;
  const { title, url, category, description, provider, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!title || !url) {
    return res.status(400).json({ error: 'title and url are required.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO learning_resources (tenant_id, branch_id, title, url, category, description, provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [tenantId, branchId || null, title, url, category || null, description || null, provider || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] createResource failed', err);
    return res.status(500).json({ error: 'Failed to create learning resource.' });
  }
}

/**
 * PATCH /learning/resources/:id
 * Update a learning resource.
 */
async function updateResource(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { title, url, category, description, provider, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `UPDATE learning_resources
          SET title = COALESCE($1, title),
              url = COALESCE($2, url),
              category = COALESCE($3, category),
              description = COALESCE($4, description),
              provider = COALESCE($5, provider),
              branch_id = COALESCE($6, branch_id),
              updated_at = NOW()
        WHERE id = $7 AND tenant_id = $8
        RETURNING *`,
      [title, url, category, description, provider, branchId, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Resource not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] updateResource error:', err);
    return res.status(500).json({ error: 'Failed to update learning resource.' });
  }
}

/**
 * DELETE /learning/resources/:id
 * Delete a learning resource.
 */
async function deleteResource(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM learning_resources WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Resource not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Learning resource deleted successfully.' });
  } catch (err) {
    console.error('[learningController] deleteResource error:', err);
    return res.status(500).json({ error: 'Failed to delete learning resource.' });
  }
}


// ---------------------------------------------------------------------
// STUDY SCHEDULES
// ---------------------------------------------------------------------

/**
 * GET /learning/schedules
 * List all study schedules for the active tenant, left-joining resources for the resource title.
 */
async function listSchedules(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `SELECT s.*, r.title AS resource_title
         FROM study_schedule s
         LEFT JOIN learning_resources r ON s.resource_id = r.id
        WHERE s.tenant_id = $1
        ORDER BY s.scheduled_at ASC`,
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[learningController] listSchedules failed', err);
    return res.status(500).json({ error: 'Failed to list study schedules.' });
  }
}

/**
 * POST /learning/schedules
 * Create a new study schedule under the active tenant.
 */
async function createSchedule(req, res) {
  const tenantId = req.tenantId;
  const { title, topic, resourceId, scheduledAt, durationMinutes, status = 'Planned', notes, branchId, reminderEmail, reminderLeadMinutes } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!title) return res.status(400).json({ error: 'title is required.' });

  const emailToUse = (reminderEmail !== undefined && reminderEmail !== null && reminderEmail !== '') ? reminderEmail : 'kmaisan@dspng.tech';
  const leadMinutesToUse = (reminderLeadMinutes !== undefined && reminderLeadMinutes !== null && reminderLeadMinutes !== '') ? parseInt(reminderLeadMinutes, 10) : 60;

  try {
    const result = await db.query(
      `INSERT INTO study_schedule (tenant_id, branch_id, title, topic, resource_id, scheduled_at, duration_minutes, status, notes, reminder_email, reminder_lead_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [tenantId, branchId || null, title, topic || null, resourceId || null, scheduledAt || null, durationMinutes || null, status, notes || null, emailToUse, leadMinutesToUse]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] createSchedule failed', err);
    return res.status(500).json({ error: 'Failed to create study schedule.' });
  }
}

/**
 * PATCH /learning/schedules/:id
 * Update a study schedule.
 */
async function updateSchedule(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { title, topic, resourceId, scheduledAt, durationMinutes, status, notes, branchId, reminderEmail, reminderLeadMinutes } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  const parsedLeadMinutes = (reminderLeadMinutes !== undefined && reminderLeadMinutes !== null) ? parseInt(reminderLeadMinutes, 10) : null;

  try {
    const result = await db.query(
      `UPDATE study_schedule
          SET title = COALESCE($1, title),
              topic = COALESCE($2, topic),
              resource_id = COALESCE($3, resource_id),
              scheduled_at = COALESCE($4, scheduled_at),
              duration_minutes = COALESCE($5, duration_minutes),
              status = COALESCE($6, status),
              notes = COALESCE($7, notes),
              branch_id = COALESCE($8, branch_id),
              reminder_email = COALESCE($9, reminder_email),
              reminder_lead_minutes = COALESCE($10, reminder_lead_minutes),
              updated_at = NOW()
        WHERE id = $11 AND tenant_id = $12
        RETURNING *`,
      [title, topic, resourceId, scheduledAt, durationMinutes, status, notes, branchId, reminderEmail, parsedLeadMinutes, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Schedule not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] updateSchedule error:', err);
    return res.status(500).json({ error: 'Failed to update study schedule.' });
  }
}

/**
 * DELETE /learning/schedules/:id
 * Delete a study schedule.
 */
async function deleteSchedule(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM study_schedule WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Schedule not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Study schedule deleted successfully.' });
  } catch (err) {
    console.error('[learningController] deleteSchedule error:', err);
    return res.status(500).json({ error: 'Failed to delete study schedule.' });
  }
}

module.exports = {
  listResources,
  createResource,
  updateResource,
  deleteResource,
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule
};
