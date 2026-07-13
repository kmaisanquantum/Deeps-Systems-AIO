// =====================================================================
// index.js — Deeps Systems AIO backend entrypoint
// =====================================================================
'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const { tenantResolver } = require('./middleware/tenantResolver');
const routes = require('./routes/index');

const app = express();

app.set('trust proxy', true); // required behind Coolify's reverse proxy

app.use(helmet());
app.use(cors());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

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

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`[deeps-systems-aio] listening on port ${PORT}`);
});

module.exports = app;
