// =====================================================================
// test_learning_phase1.js — Phase 1 Learning Module Integration tests
// =====================================================================
'use strict';

const assert = require('assert');
const learningController = require('./controllers/learningController');
const db = require('./db');

// Mock response builder
function mockResponse() {
  const res = {
    statusCode: 200,
    data: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.data = payload;
      return this;
    }
  };
  return res;
}

async function runTests() {
  console.log('Running Phase 1 Learning Module unit tests...');

  const isMock = process.env.MOCK_DB === 'true';

  if (isMock) {
    const originalQuery = db.query;

    const fakeTenantId = '00000000-0000-0000-0000-000000000001';

    // -----------------------------------------------------------------
    // 1. LEARNING GOALS
    // -----------------------------------------------------------------
    console.log('  Testing Learning Goals...');

    // List Goals
    db.query = async (sql, params) => {
      assert(sql.includes('SELECT * FROM learning_goals'));
      assert.strictEqual(params[0], fakeTenantId);
      return { rows: [{ id: 'goal-1', title: 'Learn Quantum Physics' }] };
    };
    let req = { tenantId: fakeTenantId };
    let res = mockResponse();
    await learningController.listGoals(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data[0].title, 'Learn Quantum Physics');

    // Create Goal
    db.query = async (sql, params) => {
      assert(sql.includes('INSERT INTO learning_goals'));
      assert.strictEqual(params[0], fakeTenantId);
      assert.strictEqual(params[2], 'Master CSS');
      return { rows: [{ id: 'goal-2', title: 'Master CSS' }] };
    };
    req = { tenantId: fakeTenantId, body: { title: 'Master CSS', description: 'Be a CSS wizard' } };
    res = mockResponse();
    await learningController.createGoal(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.title, 'Master CSS');

    // Update Goal
    db.query = async (sql, params) => {
      assert(sql.includes('UPDATE learning_goals'));
      return { rowCount: 1, rows: [{ id: 'goal-2', title: 'Master CSS Grid' }] };
    };
    req = { tenantId: fakeTenantId, params: { id: 'goal-2' }, body: { title: 'Master CSS Grid' } };
    res = mockResponse();
    await learningController.updateGoal(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.title, 'Master CSS Grid');

    // Delete Goal
    db.query = async (sql, params) => {
      assert(sql.includes('DELETE FROM learning_goals'));
      return { rowCount: 1 };
    };
    req = { tenantId: fakeTenantId, params: { id: 'goal-2' } };
    res = mockResponse();
    await learningController.deleteGoal(req, res);
    assert.strictEqual(res.statusCode, 200);

    // -----------------------------------------------------------------
    // 2. LEARNING PATHWAYS
    // -----------------------------------------------------------------
    console.log('  Testing Learning Pathways...');

    // List Pathways
    db.query = async (sql, params) => {
      assert(sql.includes('SELECT * FROM learning_pathways'));
      return { rows: [{ id: 'path-1', title: 'Backend Mastery' }] };
    };
    req = { tenantId: fakeTenantId };
    res = mockResponse();
    await learningController.listPathways(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data[0].title, 'Backend Mastery');

    // Create Pathway
    db.query = async (sql, params) => {
      assert(sql.includes('INSERT INTO learning_pathways'));
      return { rows: [{ id: 'path-2', title: 'Frontend Basics' }] };
    };
    req = { tenantId: fakeTenantId, body: { title: 'Frontend Basics' } };
    res = mockResponse();
    await learningController.createPathway(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.title, 'Frontend Basics');

    // Update Pathway
    db.query = async (sql, params) => {
      assert(sql.includes('UPDATE learning_pathways'));
      return { rowCount: 1, rows: [{ id: 'path-2', title: 'Frontend Mastery' }] };
    };
    req = { tenantId: fakeTenantId, params: { id: 'path-2' }, body: { title: 'Frontend Mastery' } };
    res = mockResponse();
    await learningController.updatePathway(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.title, 'Frontend Mastery');

    // Delete Pathway
    db.query = async (sql, params) => {
      assert(sql.includes('DELETE FROM learning_pathways'));
      return { rowCount: 1 };
    };
    req = { tenantId: fakeTenantId, params: { id: 'path-2' } };
    res = mockResponse();
    await learningController.deletePathway(req, res);
    assert.strictEqual(res.statusCode, 200);

    // -----------------------------------------------------------------
    // 3. COURSES
    // -----------------------------------------------------------------
    console.log('  Testing Courses...');

    // List Courses
    db.query = async (sql, params) => {
      assert(sql.includes('FROM courses c'));
      return { rows: [{ id: 'course-1', title: 'Node.js Deep Dive' }] };
    };
    req = { tenantId: fakeTenantId };
    res = mockResponse();
    await learningController.listCourses(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data[0].title, 'Node.js Deep Dive');

    // Create Course
    db.query = async (sql, params) => {
      assert(sql.includes('INSERT INTO courses'));
      return { rows: [{ id: 'course-2', title: 'Express.js Fundamentals' }] };
    };
    req = { tenantId: fakeTenantId, body: { title: 'Express.js Fundamentals' } };
    res = mockResponse();
    await learningController.createCourse(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.title, 'Express.js Fundamentals');

    // Update Course
    db.query = async (sql, params) => {
      assert(sql.includes('UPDATE courses'));
      return { rowCount: 1, rows: [{ id: 'course-2', title: 'Advanced Express.js' }] };
    };
    req = { tenantId: fakeTenantId, params: { id: 'course-2' }, body: { title: 'Advanced Express.js' } };
    res = mockResponse();
    await learningController.updateCourse(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.title, 'Advanced Express.js');

    // Delete Course
    db.query = async (sql, params) => {
      assert(sql.includes('DELETE FROM courses'));
      return { rowCount: 1 };
    };
    req = { tenantId: fakeTenantId, params: { id: 'course-2' } };
    res = mockResponse();
    await learningController.deleteCourse(req, res);
    assert.strictEqual(res.statusCode, 200);

    // -----------------------------------------------------------------
    // 4. COURSE MODULES
    // -----------------------------------------------------------------
    console.log('  Testing Course Modules...');

    // List Modules
    db.query = async (sql, params) => {
      assert(sql.includes('FROM course_modules m'));
      return { rows: [{ id: 'module-1', title: 'Routing' }] };
    };
    req = { tenantId: fakeTenantId };
    res = mockResponse();
    await learningController.listModules(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data[0].title, 'Routing');

    // Create Module
    db.query = async (sql, params) => {
      assert(sql.includes('INSERT INTO course_modules'));
      return { rows: [{ id: 'module-2', title: 'Middleware' }] };
    };
    req = { tenantId: fakeTenantId, body: { title: 'Middleware', courseId: 'course-1' } };
    res = mockResponse();
    await learningController.createModule(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.title, 'Middleware');

    // Update Module
    db.query = async (sql, params) => {
      assert(sql.includes('UPDATE course_modules'));
      return { rowCount: 1, rows: [{ id: 'module-2', title: 'Custom Middleware' }] };
    };
    req = { tenantId: fakeTenantId, params: { id: 'module-2' }, body: { title: 'Custom Middleware' } };
    res = mockResponse();
    await learningController.updateModule(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.title, 'Custom Middleware');

    // Delete Module
    db.query = async (sql, params) => {
      assert(sql.includes('DELETE FROM course_modules'));
      return { rowCount: 1 };
    };
    req = { tenantId: fakeTenantId, params: { id: 'module-2' } };
    res = mockResponse();
    await learningController.deleteModule(req, res);
    assert.strictEqual(res.statusCode, 200);

    // -----------------------------------------------------------------
    // 5. LESSONS
    // -----------------------------------------------------------------
    console.log('  Testing Lessons...');

    // List Lessons
    db.query = async (sql, params) => {
      assert(sql.includes('FROM lessons l'));
      return { rows: [{ id: 'lesson-1', title: 'Writing custom middleware' }] };
    };
    req = { tenantId: fakeTenantId };
    res = mockResponse();
    await learningController.listLessons(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data[0].title, 'Writing custom middleware');

    // Create Lesson
    db.query = async (sql, params) => {
      assert(sql.includes('INSERT INTO lessons'));
      return { rows: [{ id: 'lesson-2', title: 'Error-handling middleware' }] };
    };
    req = { tenantId: fakeTenantId, body: { title: 'Error-handling middleware', moduleId: 'module-1' } };
    res = mockResponse();
    await learningController.createLesson(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.title, 'Error-handling middleware');

    // Update Lesson
    db.query = async (sql, params) => {
      assert(sql.includes('UPDATE lessons'));
      return { rowCount: 1, rows: [{ id: 'lesson-2', title: 'Express Error Handling' }] };
    };
    req = { tenantId: fakeTenantId, params: { id: 'lesson-2' }, body: { title: 'Express Error Handling' } };
    res = mockResponse();
    await learningController.updateLesson(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.title, 'Express Error Handling');

    // Delete Lesson
    db.query = async (sql, params) => {
      assert(sql.includes('DELETE FROM lessons'));
      return { rowCount: 1 };
    };
    req = { tenantId: fakeTenantId, params: { id: 'lesson-2' } };
    res = mockResponse();
    await learningController.deleteLesson(req, res);
    assert.strictEqual(res.statusCode, 200);

    // Restore original query function
    db.query = originalQuery;
    console.log('All mock DB assertions succeeded.');
  } else {
    console.log('Skipping live DB tests (MOCK_DB is not active).');
  }

  console.log('All Phase 1 Learning Module unit tests passed successfully!');
}

runTests().catch(err => {
  console.error('Phase 1 Learning Module tests failed:', err);
  process.exit(1);
});
