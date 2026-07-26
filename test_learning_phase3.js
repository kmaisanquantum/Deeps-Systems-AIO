// =====================================================================
// test_learning_phase3.js — Phase 3 Assessment Integration tests
// =====================================================================
'use strict';

const assert = require('assert');
const learningController = require('./controllers/learningController');
const db = require('./db');

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
  console.log('Running Phase 3 Assessment Module unit tests...');

  const originalQuery = db.query;
  const fakeTenantId = '00000000-0000-0000-0000-000000000001';

  // 1. Quizzes List
  db.query = async (sql, params) => {
    assert(sql.includes('SELECT * FROM quizzes'));
    return { rows: [{ id: 'quiz-1', title: 'PostgreSQL Indexes Quiz', lesson_id: 'lesson-1' }] };
  };
  let req = { tenantId: fakeTenantId, query: { lessonId: 'lesson-1' } };
  let res = mockResponse();
  await learningController.listQuizzes(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.data[0].title, 'PostgreSQL Indexes Quiz');

  // 2. Quizzes Create
  db.query = async (sql, params) => {
    assert(sql.includes('INSERT INTO quizzes'));
    assert.strictEqual(params[3], 'New Quiz');
    return { rows: [{ id: 'quiz-2', title: 'New Quiz', lesson_id: 'lesson-2' }] };
  };
  req = { tenantId: fakeTenantId, body: { lessonId: 'lesson-2', title: 'New Quiz', passingScore: 80 } };
  res = mockResponse();
  await learningController.createQuiz(req, res);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.data.title, 'New Quiz');

  // 3. Quiz Questions Create
  db.query = async (sql, params) => {
    assert(sql.includes('INSERT INTO quiz_questions'));
    assert.strictEqual(params[3], 'What is 1+1?');
    return { rows: [{ id: 'question-1', question_text: 'What is 1+1?' }] };
  };
  req = { tenantId: fakeTenantId, body: { quizId: 'quiz-1', questionText: 'What is 1+1?', questionType: 'multiple_choice', choices: ['1','2','3'], correctAnswer: '2' } };
  res = mockResponse();
  await learningController.createQuizQuestion(req, res);
  assert.strictEqual(res.statusCode, 201);

  // 4. Grading / submitQuizAttempt
  db.query = async (sql, params) => {
    if (sql.includes('SELECT * FROM quizzes')) {
      return { rowCount: 1, rows: [{ id: 'quiz-1', lesson_id: 'lesson-1', passing_score: 70 }] };
    }
    if (sql.includes('SELECT * FROM quiz_questions')) {
      return {
        rows: [
          { id: 'q-1', question_text: 'Is SQL cool?', question_type: 'true_false', correct_answer: 'true' },
          { id: 'q-2', question_text: 'Explain indexing', question_type: 'short_answer', correct_answer: '' }
        ]
      };
    }
    if (sql.includes('INSERT INTO quiz_attempts')) {
      return { rows: [{ id: 'attempt-1', passed: true, score: 100 }] };
    }
    if (sql.includes('SELECT * FROM lessons')) {
      return { rowCount: 1, rows: [{ id: 'lesson-1', requires_quiz: true, requires_recall: false, requires_practice: false }] };
    }
    if (sql.includes('UPDATE lessons')) {
      return { rowCount: 1 };
    }
    return { rows: [] };
  };

  req = {
    tenantId: fakeTenantId,
    params: { id: 'quiz-1' },
    body: { answers: { 'q-1': 'true', 'q-2': 'I think indexing creates B-trees' } }
  };
  res = mockResponse();
  await learningController.submitQuizAttempt(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.data.passed, true);
  assert.strictEqual(res.data.score, 100);

  db.query = originalQuery;
  console.log('All mock Phase 3 assertions succeeded.');
}

runTests().catch(err => {
  console.error('Phase 3 assessment tests failed:', err);
  process.exit(1);
});
