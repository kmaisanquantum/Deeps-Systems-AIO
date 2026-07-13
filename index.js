// =====================================================================
// index.js — Deeps Systems AIO backend entrypoint
// =====================================================================
'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const { tenantResolver } = require('./middleware/tenantResolver');
const routes = require('./routes/index');

const app = express();

app.set('trust proxy', true); // required behind Coolify's reverse proxy

app.use(helmet());
app.use(cors());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static assets from public/ directory before routing or resolving tenants.
// This allows the frontend landing page and assets to render cleanly and quickly.
app.use(express.static(path.join(__dirname, 'public')));

// Resolve tenant/branch context on every request before hitting routes.
app.use(tenantResolver);

app.use('/', routes);

// Centralized error handler — catches anything thrown/rejected that
// wasn't already handled inside a controller's try/catch.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[app] unhandled error', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

const PORT = process.env.PORT || 5000;

async function startServer() {
  // Database initialization from init.sql
  console.log('[app] starting database schema initialization...');
  try {
    const initSqlPath = path.join(__dirname, 'init.sql');
    if (fs.existsSync(initSqlPath)) {
      const sql = fs.readFileSync(initSqlPath, 'utf8');
      await db.query(sql);
      console.log('[app] database schema initialized successfully.');
    } else {
      console.warn('[app] init.sql not found, skipping schema initialization.');
    }
  } catch (err) {
    console.error('[app] critical error: database schema initialization failed:', err);
    // It's safer to exit the process if critical database migration/setup fails
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[deeps-systems-aio] listening on port ${PORT}`);
  });
}

startServer();

module.exports = app;
