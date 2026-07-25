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

    const schedule = result.rows[0];
    const eventDispatcher = require('../services/eventDispatcher');
    eventDispatcher.dispatchAsync('learning.schedule_created', tenantId, {
      schedule,
      studentUserId: req.body.studentUserId || req.body.userId || null
    });

    return res.status(201).json(schedule);
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

// ---------------------------------------------------------------------
// LEARNING GOALS
// ---------------------------------------------------------------------

/**
 * GET /learning/goals
 */
async function listGoals(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'SELECT * FROM learning_goals WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[learningController] listGoals failed', err);
    return res.status(500).json({ error: 'Failed to list learning goals.' });
  }
}

/**
 * POST /learning/goals
 */
async function createGoal(req, res) {
  const tenantId = req.tenantId;
  const { title, description, targetDate, status = 'In Progress', branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!title) return res.status(400).json({ error: 'title is required.' });

  try {
    const result = await db.query(
      `INSERT INTO learning_goals (tenant_id, branch_id, title, description, target_date, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tenantId, branchId || null, title, description || null, targetDate || null, status]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] createGoal failed', err);
    return res.status(500).json({ error: 'Failed to create learning goal.' });
  }
}

/**
 * PATCH /learning/goals/:id
 */
async function updateGoal(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { title, description, targetDate, status, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `UPDATE learning_goals
          SET title = COALESCE($1, title),
              description = COALESCE($2, description),
              target_date = COALESCE($3, target_date),
              status = COALESCE($4, status),
              branch_id = COALESCE($5, branch_id),
              updated_at = NOW()
        WHERE id = $6 AND tenant_id = $7
        RETURNING *`,
      [title, description, targetDate, status, branchId, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Goal not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] updateGoal failed', err);
    return res.status(500).json({ error: 'Failed to update learning goal.' });
  }
}

/**
 * DELETE /learning/goals/:id
 */
async function deleteGoal(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM learning_goals WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Goal not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Learning goal deleted successfully.' });
  } catch (err) {
    console.error('[learningController] deleteGoal failed', err);
    return res.status(500).json({ error: 'Failed to delete learning goal.' });
  }
}

// ---------------------------------------------------------------------
// LEARNING PATHWAYS
// ---------------------------------------------------------------------

/**
 * GET /learning/pathways
 */
async function listPathways(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'SELECT * FROM learning_pathways WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[learningController] listPathways failed', err);
    return res.status(500).json({ error: 'Failed to list learning pathways.' });
  }
}

/**
 * POST /learning/pathways
 */
async function createPathway(req, res) {
  const tenantId = req.tenantId;
  const { title, description, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!title) return res.status(400).json({ error: 'title is required.' });

  try {
    const result = await db.query(
      `INSERT INTO learning_pathways (tenant_id, branch_id, title, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, branchId || null, title, description || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] createPathway failed', err);
    return res.status(500).json({ error: 'Failed to create learning pathway.' });
  }
}

/**
 * PATCH /learning/pathways/:id
 */
async function updatePathway(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { title, description, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `UPDATE learning_pathways
          SET title = COALESCE($1, title),
              description = COALESCE($2, description),
              branch_id = COALESCE($3, branch_id),
              updated_at = NOW()
        WHERE id = $4 AND tenant_id = $5
        RETURNING *`,
      [title, description, branchId, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Pathway not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] updatePathway failed', err);
    return res.status(500).json({ error: 'Failed to update learning pathway.' });
  }
}

/**
 * DELETE /learning/pathways/:id
 */
async function deletePathway(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM learning_pathways WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Pathway not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Learning pathway deleted successfully.' });
  } catch (err) {
    console.error('[learningController] deletePathway failed', err);
    return res.status(500).json({ error: 'Failed to delete learning pathway.' });
  }
}

// ---------------------------------------------------------------------
// COURSES
// ---------------------------------------------------------------------

/**
 * GET /learning/courses
 */
async function listCourses(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `SELECT c.*, p.title AS pathway_title
         FROM courses c
         LEFT JOIN learning_pathways p ON c.pathway_id = p.id
        WHERE c.tenant_id = $1
        ORDER BY c.created_at DESC`,
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[learningController] listCourses failed', err);
    return res.status(500).json({ error: 'Failed to list courses.' });
  }
}

/**
 * POST /learning/courses
 */
async function createCourse(req, res) {
  const tenantId = req.tenantId;
  const { title, description, pathwayId, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!title) return res.status(400).json({ error: 'title is required.' });

  try {
    const result = await db.query(
      `INSERT INTO courses (tenant_id, branch_id, pathway_id, title, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [tenantId, branchId || null, pathwayId || null, title, description || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] createCourse failed', err);
    return res.status(500).json({ error: 'Failed to create course.' });
  }
}

/**
 * PATCH /learning/courses/:id
 */
async function updateCourse(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { title, description, pathwayId, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `UPDATE courses
          SET title = COALESCE($1, title),
              description = COALESCE($2, description),
              pathway_id = COALESCE($3, pathway_id),
              branch_id = COALESCE($4, branch_id),
              updated_at = NOW()
        WHERE id = $5 AND tenant_id = $6
        RETURNING *`,
      [title, description, pathwayId, branchId, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Course not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] updateCourse failed', err);
    return res.status(500).json({ error: 'Failed to update course.' });
  }
}

/**
 * DELETE /learning/courses/:id
 */
async function deleteCourse(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM courses WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Course not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Course deleted successfully.' });
  } catch (err) {
    console.error('[learningController] deleteCourse failed', err);
    return res.status(500).json({ error: 'Failed to delete course.' });
  }
}

// ---------------------------------------------------------------------
// COURSE MODULES
// ---------------------------------------------------------------------

/**
 * GET /learning/modules
 */
async function listModules(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `SELECT m.*, c.title AS course_title
         FROM course_modules m
         LEFT JOIN courses c ON m.course_id = c.id
        WHERE m.tenant_id = $1
        ORDER BY m.sequence_order ASC, m.created_at DESC`,
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[learningController] listModules failed', err);
    return res.status(500).json({ error: 'Failed to list course modules.' });
  }
}

/**
 * POST /learning/modules
 */
async function createModule(req, res) {
  const tenantId = req.tenantId;
  const { title, description, courseId, sequenceOrder = 0, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!title) return res.status(400).json({ error: 'title is required.' });

  try {
    const result = await db.query(
      `INSERT INTO course_modules (tenant_id, branch_id, course_id, title, description, sequence_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tenantId, branchId || null, courseId || null, title, description || null, sequenceOrder]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] createModule failed', err);
    return res.status(500).json({ error: 'Failed to create course module.' });
  }
}

/**
 * PATCH /learning/modules/:id
 */
async function updateModule(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { title, description, courseId, sequenceOrder, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `UPDATE course_modules
          SET title = COALESCE($1, title),
              description = COALESCE($2, description),
              course_id = COALESCE($3, course_id),
              sequence_order = COALESCE($4, sequence_order),
              branch_id = COALESCE($5, branch_id),
              updated_at = NOW()
        WHERE id = $6 AND tenant_id = $7
        RETURNING *`,
      [title, description, courseId, sequenceOrder, branchId, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Module not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] updateModule failed', err);
    return res.status(500).json({ error: 'Failed to update course module.' });
  }
}

/**
 * DELETE /learning/modules/:id
 */
async function deleteModule(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM course_modules WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Module not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Course module deleted successfully.' });
  } catch (err) {
    console.error('[learningController] deleteModule failed', err);
    return res.status(500).json({ error: 'Failed to delete course module.' });
  }
}

// ---------------------------------------------------------------------
// LESSONS
// ---------------------------------------------------------------------

/**
 * GET /learning/lessons
 */
async function listLessons(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `SELECT l.*, m.title AS module_title
         FROM lessons l
         LEFT JOIN course_modules m ON l.module_id = m.id
        WHERE l.tenant_id = $1
        ORDER BY l.sequence_order ASC, l.created_at DESC`,
      [tenantId]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[learningController] listLessons failed', err);
    return res.status(500).json({ error: 'Failed to list lessons.' });
  }
}

/**
 * POST /learning/lessons
 */
async function createLesson(req, res) {
  const tenantId = req.tenantId;
  const {
    title,
    content,
    moduleId,
    sequenceOrder = 0,
    branchId,
    estMinutes,
    resourceId,
    requiresRecall,
    requiresPractice,
    status = 'Not Started',
    completionPct = 0
  } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!title) return res.status(400).json({ error: 'title is required.' });

  const est = estMinutes !== undefined && estMinutes !== '' ? parseInt(estMinutes, 10) : null;
  const pct = completionPct !== undefined && completionPct !== '' ? parseInt(completionPct, 10) : 0;
  const reqRecall = requiresRecall !== undefined ? (requiresRecall === true || requiresRecall === 'true') : true;
  const reqPractice = requiresPractice !== undefined ? (requiresPractice === true || requiresPractice === 'true') : false;

  try {
    const result = await db.query(
      `INSERT INTO lessons (
         tenant_id, branch_id, module_id, title, content, sequence_order,
         est_minutes, resource_id, requires_recall, requires_practice, status, completion_pct
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        tenantId,
        branchId || null,
        moduleId || null,
        title,
        content || null,
        sequenceOrder,
        est,
        resourceId || null,
        reqRecall,
        reqPractice,
        status,
        pct
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] createLesson failed', err);
    return res.status(500).json({ error: 'Failed to create lesson.' });
  }
}

/**
 * PATCH /learning/lessons/:id
 */
async function updateLesson(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const {
    title,
    content,
    moduleId,
    sequenceOrder,
    branchId,
    estMinutes,
    resourceId,
    requiresRecall,
    requiresPractice,
    status,
    completionPct
  } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  const est = estMinutes !== undefined ? (estMinutes === '' ? null : parseInt(estMinutes, 10)) : undefined;
  const pct = completionPct !== undefined ? (completionPct === '' ? null : parseInt(completionPct, 10)) : undefined;
  const reqRecall = requiresRecall !== undefined ? (requiresRecall === true || requiresRecall === 'true') : undefined;
  const reqPractice = requiresPractice !== undefined ? (requiresPractice === true || requiresPractice === 'true') : undefined;

  try {
    const result = await db.query(
      `UPDATE lessons
          SET title = COALESCE($1, title),
              content = COALESCE($2, content),
              module_id = COALESCE($3, module_id),
              sequence_order = COALESCE($4, sequence_order),
              branch_id = COALESCE($5, branch_id),
              est_minutes = COALESCE($6, est_minutes),
              resource_id = COALESCE($7, resource_id),
              requires_recall = COALESCE($8, requires_recall),
              requires_practice = COALESCE($9, requires_practice),
              status = COALESCE($10, status),
              completion_pct = COALESCE($11, completion_pct),
              updated_at = NOW()
        WHERE id = $12 AND tenant_id = $13
        RETURNING *`,
      [
        title !== undefined ? title : null,
        content !== undefined ? content : null,
        moduleId !== undefined ? moduleId : null,
        sequenceOrder !== undefined ? sequenceOrder : null,
        branchId !== undefined ? branchId : null,
        est,
        resourceId !== undefined ? resourceId : null,
        reqRecall,
        reqPractice,
        status !== undefined ? status : null,
        pct,
        id,
        tenantId
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Lesson not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] updateLesson failed', err);
    return res.status(500).json({ error: 'Failed to update lesson.' });
  }
}

/**
 * DELETE /learning/lessons/:id
 */
async function deleteLesson(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM lessons WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Lesson not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Lesson deleted successfully.' });
  } catch (err) {
    console.error('[learningController] deleteLesson failed', err);
    return res.status(500).json({ error: 'Failed to delete lesson.' });
  }
}

/**
 * GET /learning/today
 * Compute next lesson and fetch streak.
 */
async function getTodaysLearning(req, res) {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    // 1. Get streak
    const streakRes = await db.query(
      'SELECT current_streak, longest_streak, last_study_date::text FROM study_streaks WHERE tenant_id = $1',
      [tenantId]
    );
    const streak = streakRes.rows[0] || { current_streak: 0, longest_streak: 0, last_study_date: null };

    // 2. Walk pathway -> courses -> modules -> next uncompleted lesson
    const missionRes = await db.query(
      `SELECT l.id AS lesson_id,
              l.title AS lesson_title,
              l.content AS lesson_content,
              l.status AS lesson_status,
              l.completion_pct,
              l.est_minutes,
              l.requires_recall,
              l.requires_practice,
              m.title AS module_title,
              c.title AS course_title,
              p.title AS pathway_title,
              r.url AS resource_url
         FROM learning_pathways p
         JOIN courses c ON c.pathway_id = p.id
         JOIN course_modules m ON m.course_id = c.id
         JOIN lessons l ON l.module_id = m.id
         LEFT JOIN learning_resources r ON l.resource_id = r.id
        WHERE p.tenant_id = $1
          AND l.status != 'Completed'
        ORDER BY p.created_at ASC,
                 c.created_at ASC,
                 m.sequence_order ASC, m.created_at ASC,
                 l.sequence_order ASC, l.created_at ASC
        LIMIT 1`,
      [tenantId]
    );

    const mission = missionRes.rows[0] || null;

    return res.status(200).json({
      current_streak: streak.current_streak,
      longest_streak: streak.longest_streak,
      last_study_date: streak.last_study_date,
      today_mission: mission
    });
  } catch (err) {
    console.error('[learningController] getTodaysLearning failed', err);
    return res.status(500).json({ error: 'Failed to retrieve today\'s learning mission.' });
  }
}

/**
 * POST /learning/sessions/start
 * body: { lessonId, scheduleId }
 */
async function startStudySession(req, res) {
  const tenantId = req.tenantId;
  const { lessonId, scheduleId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!lessonId) return res.status(400).json({ error: 'lessonId is required.' });

  try {
    // 1. Set lesson to 'In Progress'
    await db.query(
      `UPDATE lessons SET status = 'In Progress', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [lessonId, tenantId]
    );

    // 2. Insert session log
    const result = await db.query(
      `INSERT INTO study_session_logs (tenant_id, lesson_id, schedule_id, started_at, status)
       VALUES ($1, $2, $3, NOW(), 'In Progress')
       RETURNING id`,
      [tenantId, lessonId, scheduleId || null]
    );

    return res.status(201).json({ log_id: result.rows[0].id });
  } catch (err) {
    console.error('[learningController] startStudySession failed', err);
    return res.status(500).json({ error: 'Failed to start study session.' });
  }
}

/**
 * POST /learning/sessions/:id/complete
 */
async function completeStudySession(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    // 1. Fetch session
    const sessionRes = await db.query(
      'SELECT * FROM study_session_logs WHERE id = $1 AND tenant_id = $2',
      [id, tenantId]
    );
    if (sessionRes.rowCount === 0) {
      return res.status(404).json({ error: 'Study session not found.' });
    }

    const session = sessionRes.rows[0];
    const lessonId = session.lesson_id;

    // 2. Compute actual minutes
    const startedAt = new Date(session.started_at);
    const endedAt = new Date();
    const actualMinutes = Math.max(1, Math.round((endedAt - startedAt) / 60000));

    // 3. Update session log
    await db.query(
      `UPDATE study_session_logs
          SET ended_at = NOW(),
              actual_minutes = $1,
              status = 'Completed',
              updated_at = NOW()
        WHERE id = $2 AND tenant_id = $3`,
      [actualMinutes, id, tenantId]
    );

    // 4. Fetch lesson details
    const lessonRes = await db.query(
      'SELECT * FROM lessons WHERE id = $1 AND tenant_id = $2',
      [lessonId, tenantId]
    );
    if (lessonRes.rowCount === 0) {
      return res.status(404).json({ error: 'Lesson not found.' });
    }
    const lesson = lessonRes.rows[0];

    // 5. Check if required activities are satisfied
    let satisfied = true;

    if (lesson.requires_recall) {
      const recallCheck = await db.query(
        'SELECT COUNT(*)::integer AS count FROM recall_entries WHERE lesson_id = $1 AND session_log_id = $2 AND tenant_id = $3',
        [lessonId, id, tenantId]
      );
      if (recallCheck.rows[0].count === 0) {
        satisfied = false;
      }
    }

    if (lesson.requires_practice) {
      const practiceCheck = await db.query(
        `SELECT COUNT(*)::integer AS count FROM practice_tasks
          WHERE lesson_id = $1 AND status != 'Completed' AND tenant_id = $2`,
        [lessonId, tenantId]
      );
      if (practiceCheck.rows[0].count > 0) {
        satisfied = false;
      }
    }

    // 6. Update lesson status if satisfied
    if (satisfied) {
      await db.query(
        `UPDATE lessons SET status = 'Completed', completion_pct = 100, updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
        [lessonId, tenantId]
      );
    }

    // 7. Update streaks
    const streakRes = await db.query(
      `SELECT current_streak, longest_streak, last_study_date::text AS last_study_date,
              CURRENT_DATE::text AS today,
              (CURRENT_DATE - INTERVAL '1 day')::date::text AS yesterday
         FROM study_streaks WHERE tenant_id = $1`,
      [tenantId]
    );

    if (streakRes.rowCount === 0) {
      await db.query(
        `INSERT INTO study_streaks (tenant_id, current_streak, longest_streak, last_study_date)
         VALUES ($1, 1, 1, CURRENT_DATE)
         ON CONFLICT (tenant_id) DO UPDATE
         SET current_streak = 1,
             longest_streak = GREATEST(study_streaks.longest_streak, 1),
             last_study_date = CURRENT_DATE`,
        [tenantId]
      );
    } else {
      const { current_streak, longest_streak, last_study_date, today, yesterday } = streakRes.rows[0];
      let newStreak = current_streak;
      let newLongest = longest_streak;

      if (last_study_date === today) {
        // no-op
      } else if (last_study_date === yesterday) {
        newStreak = current_streak + 1;
        newLongest = Math.max(longest_streak, newStreak);
        await db.query(
          `UPDATE study_streaks
              SET current_streak = $1, longest_streak = $2, last_study_date = CURRENT_DATE, updated_at = NOW()
            WHERE tenant_id = $3`,
          [newStreak, newLongest, tenantId]
        );
      } else {
        newStreak = 1;
        newLongest = Math.max(longest_streak, 1);
        await db.query(
          `UPDATE study_streaks
              SET current_streak = $1, longest_streak = $2, last_study_date = CURRENT_DATE, updated_at = NOW()
            WHERE tenant_id = $3`,
          [newStreak, newLongest, tenantId]
        );
      }
    }

    return res.status(200).json({
      message: 'Study session completed successfully.',
      actual_minutes,
      satisfied,
      lesson_status: satisfied ? 'Completed' : 'In Progress'
    });
  } catch (err) {
    console.error('[learningController] completeStudySession failed', err);
    return res.status(500).json({ error: 'Failed to complete study session.' });
  }
}

/**
 * GET /learning/recalls
 */
async function listRecallEntries(req, res) {
  const tenantId = req.tenantId;
  const { lessonId, sessionLogId } = req.query || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    let sql = 'SELECT * FROM recall_entries WHERE tenant_id = $1';
    const params = [tenantId];

    if (lessonId) {
      params.push(lessonId);
      sql += ` AND lesson_id = $${params.length}`;
    }
    if (sessionLogId) {
      params.push(sessionLogId);
      sql += ` AND session_log_id = $${params.length}`;
    }

    sql += ' ORDER BY created_at DESC';

    const result = await db.query(sql, params);
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[learningController] listRecallEntries failed', err);
    return res.status(500).json({ error: 'Failed to list recall entries.' });
  }
}

/**
 * POST /learning/recalls
 */
async function createRecallEntry(req, res) {
  const tenantId = req.tenantId;
  const { lessonId, sessionLogId, content, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!lessonId || !sessionLogId || !content) {
    return res.status(400).json({ error: 'lessonId, sessionLogId, and content are required.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO recall_entries (tenant_id, branch_id, lesson_id, session_log_id, content)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [tenantId, branchId || null, lessonId, sessionLogId, content]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] createRecallEntry failed', err);
    return res.status(500).json({ error: 'Failed to create recall entry.' });
  }
}

/**
 * GET /learning/practice-tasks
 */
async function listPracticeTasks(req, res) {
  const tenantId = req.tenantId;
  const { lessonId } = req.query || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    let sql = 'SELECT * FROM practice_tasks WHERE tenant_id = $1';
    const params = [tenantId];

    if (lessonId) {
      params.push(lessonId);
      sql += ` AND lesson_id = $${params.length}`;
    }

    sql += ' ORDER BY created_at DESC';

    const result = await db.query(sql, params);
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('[learningController] listPracticeTasks failed', err);
    return res.status(500).json({ error: 'Failed to list practice tasks.' });
  }
}

/**
 * POST /learning/practice-tasks
 */
async function createPracticeTask(req, res) {
  const tenantId = req.tenantId;
  const { lessonId, title, description, instructions, dueDate, notes, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!lessonId || !title) {
    return res.status(400).json({ error: 'lessonId and title are required.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO practice_tasks (tenant_id, branch_id, lesson_id, title, description, instructions, due_date, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending', $8)
       RETURNING *`,
      [tenantId, branchId || null, lessonId, title, description || null, instructions || null, dueDate || null, notes || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] createPracticeTask failed', err);
    return res.status(500).json({ error: 'Failed to create practice task.' });
  }
}

/**
 * PATCH /learning/practice-tasks/:id
 */
async function updatePracticeTask(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;
  const { title, description, instructions, dueDate, status, notes, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `UPDATE practice_tasks
          SET title = COALESCE($1, title),
              description = COALESCE($2, description),
              instructions = COALESCE($3, instructions),
              due_date = COALESCE($4, due_date),
              status = COALESCE($5, status),
              notes = COALESCE($6, notes),
              branch_id = COALESCE($7, branch_id),
              updated_at = NOW()
        WHERE id = $8 AND tenant_id = $9
        RETURNING *`,
      [title, description, instructions, dueDate, status, notes, branchId, id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Practice task not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] updatePracticeTask failed', err);
    return res.status(500).json({ error: 'Failed to update practice task.' });
  }
}

/**
 * DELETE /learning/practice-tasks/:id
 */
async function deletePracticeTask(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      'DELETE FROM practice_tasks WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Practice task not found or not in tenant scope.' });
    }

    return res.status(200).json({ message: 'Practice task deleted successfully.' });
  } catch (err) {
    console.error('[learningController] deletePracticeTask failed', err);
    return res.status(500).json({ error: 'Failed to delete practice task.' });
  }
}

/**
 * PATCH /learning/practice-tasks/:id/complete
 */
async function completePracticeTask(req, res) {
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `UPDATE practice_tasks
          SET status = 'Completed', updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2
        RETURNING *`,
      [id, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Practice task not found or not in tenant scope.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[learningController] completePracticeTask failed', err);
    return res.status(500).json({ error: 'Failed to mark practice task as completed.' });
  }
}

module.exports = {
  getTodaysLearning,
  startStudySession,
  completeStudySession,
  listRecallEntries,
  createRecallEntry,
  listPracticeTasks,
  createPracticeTask,
  updatePracticeTask,
  deletePracticeTask,
  completePracticeTask,
  listResources,
  createResource,
  updateResource,
  deleteResource,
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,

  listGoals,
  createGoal,
  updateGoal,
  deleteGoal,

  listPathways,
  createPathway,
  updatePathway,
  deletePathway,

  listCourses,
  createCourse,
  updateCourse,
  deleteCourse,

  listModules,
  createModule,
  updateModule,
  deleteModule,

  listLessons,
  createLesson,
  updateLesson,
  deleteLesson
};
