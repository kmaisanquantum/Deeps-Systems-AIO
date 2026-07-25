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
  const { title, content, moduleId, sequenceOrder = 0, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });
  if (!title) return res.status(400).json({ error: 'title is required.' });

  try {
    const result = await db.query(
      `INSERT INTO lessons (tenant_id, branch_id, module_id, title, content, sequence_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tenantId, branchId || null, moduleId || null, title, content || null, sequenceOrder]
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
  const { title, content, moduleId, sequenceOrder, branchId } = req.body || {};

  if (!tenantId) return res.status(400).json({ error: 'Tenant context is required.' });

  try {
    const result = await db.query(
      `UPDATE lessons
          SET title = COALESCE($1, title),
              content = COALESCE($2, content),
              module_id = COALESCE($3, module_id),
              sequence_order = COALESCE($4, sequence_order),
              branch_id = COALESCE($5, branch_id),
              updated_at = NOW()
        WHERE id = $6 AND tenant_id = $7
        RETURNING *`,
      [title, content, moduleId, sequenceOrder, branchId, id, tenantId]
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

module.exports = {
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
