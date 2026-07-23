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
const { startAutonomousMonitor, stopAutonomousMonitor } = require('./services/autonomousMonitor');

const app = express();

app.set('trust proxy', true); // required behind Coolify's reverse proxy

// Enforce custom Content Security Policy (CSP) settings using Helmet.
// This allows the external Tailwind Play CDN script to be fetched and executed,
// style-src permits inline stylesheet generation, and script-src-attr permits
// inline module card event handlers over the HTTP test origin.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        // Allow the application to execute the Tailwind runtime compiler from the CDN
        'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.tailwindcss.com'],
        // Permit inline onClick event handlers on the workspace modules
        'script-src-attr': ["'unsafe-inline'"],
        // Allow runtime style injection by the Tailwind engine and Google Fonts styles
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        // Limit font loading to Google Fonts CDN and data URIs
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        // Ensure standard API calls tunnel properly back to the backend
        'connect-src': ["'self'"],
        // Disable automatic HTTPS upgrades to maintain connectivity on the HTTP sslip.io environment
        'upgrade-insecure-requests': null,
        // Allow the registration and activation of the PWA service worker
        'worker-src': ["'self'"],
        // Allow loading the web manifest
        'manifest-src': ["'self'"],
      },
    },
  })
);

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
  startAutonomousMonitor();
}

startServer();

// Cleanly handle shut down of db pools on termination
process.on('SIGTERM', () => {
  console.log('[app] SIGTERM received. Closing database pool...');
  stopAutonomousMonitor();
  db.pool.end(() => {
    console.log('[app] Database pool closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[app] SIGINT received. Closing database pool...');
  stopAutonomousMonitor();
  db.pool.end(() => {
    console.log('[app] Database pool closed.');
    process.exit(0);
  });
});

module.exports = app;
