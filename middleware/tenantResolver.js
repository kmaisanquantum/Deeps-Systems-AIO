// =====================================================================
// middleware/tenantResolver.js
// Resolves the tenant (and, where possible, branch) context for every
// incoming request based on subdomain + auth token, and attaches
// req.tenantId / req.branchId / req.tenant for downstream isolation.
// If the domain/subdomain cannot be matched to a database tenant,
// it falls back to a default active tenant from the database.
// =====================================================================
'use strict';

const jwt = require('jsonwebtoken');
const db = require('../db');

// Hostnames that never represent a tenant subdomain (management panel,
// bare apex domain, local dev, health checks, etc).
const RESERVED_SUBDOMAINS = new Set(['www', 'api', 'admin', 'app', 'localhost']);

const BASE_DOMAIN = process.env.BASE_DOMAIN || 'dspng.tech';

/**
 * Extract the leading label of a hostname, e.g.
 * "clientname.dspng.tech" -> "clientname"
 * "dspng.tech"            -> null (apex/root, no tenant)
 * "localhost:4000"        -> null
 */
function extractSubdomain(hostname) {
  if (!hostname) return null;

  const hostWithoutPort = hostname.split(':')[0].toLowerCase();

  if (hostWithoutPort === 'localhost' || hostWithoutPort === '127.0.0.1') {
    return null;
  }

  if (!hostWithoutPort.endsWith(BASE_DOMAIN)) {
    // Could be an IP address or an unrelated domain (e.g. health check
    // probes hitting the container directly) — treat as no-tenant.
    return null;
  }

  const withoutBase = hostWithoutPort.slice(0, -1 * (BASE_DOMAIN.length + 1));
  if (!withoutBase) return null; // exact apex match, e.g. "dspng.tech"

  const label = withoutBase.split('.')[0];
  if (RESERVED_SUBDOMAINS.has(label)) return null;

  return label;
}

/**
 * Decode the bearer token (if present) to recover branch/user context
 * without requiring a DB round trip. Falls back gracefully if absent
 * or invalid — branch resolution is best-effort at this layer; routes
 * that require auth should still run their own auth guard.
 */
function extractAuthContext(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;

  const token = header.slice('Bearer '.length).trim();
  if (!token || !process.env.JWT_SECRET) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return {
      userId: decoded.userId || decoded.sub || null,
      branchId: decoded.branchId || null,
      tenantId: decoded.tenantId || null,
      role: decoded.role || null,
    };
  } catch (err) {
    // Invalid/expired token — don't throw here, let route-level auth
    // middleware decide whether that's fatal for this endpoint.
    return null;
  }
}

/**
 * Express middleware: attaches req.tenantId, req.tenant, req.branchId,
 * and req.authUser (if a valid token was present).
 * Falls back to the default/main active tenant if the subdomain/domain
 * cannot be matched to a database tenant.
 */
async function tenantResolver(req, res, next) {
  try {
    const subdomain = extractSubdomain(req.hostname);
    const authContext = extractAuthContext(req);

    req.authUser = authContext;

    let tenant = null;

    if (subdomain) {
      const result = await db.query(
        `SELECT id, company_name, subdomain, is_active
           FROM tenants
          WHERE subdomain = $1
          LIMIT 1`,
        [subdomain]
      );

      if (result.rowCount > 0) {
        tenant = result.rows[0];
      }
    }

    // If subdomain is unresolved, unmatched, or apex domain, fall back to default/main active tenant
    if (!tenant) {
      const fallbackResult = await db.query(
        `SELECT id, company_name, subdomain, is_active
           FROM tenants
          WHERE is_active = true
          ORDER BY created_at ASC
          LIMIT 1`
      );
      if (fallbackResult.rowCount > 0) {
        tenant = fallbackResult.rows[0];
      }
    }

    if (tenant) {
      if (!tenant.is_active) {
        return res.status(403).json({ error: 'This tenant account is suspended.' });
      }

      req.tenant = tenant;
      req.tenantId = tenant.id;

      // Guard against a stale/forged token pointing at a different tenant.
      if (authContext && authContext.tenantId && authContext.tenantId !== tenant.id) {
        return res.status(403).json({ error: 'Token/tenant mismatch.' });
      }

      req.branchId = authContext ? authContext.branchId : null;
    } else {
      // No active tenants exist in the database yet (e.g. fresh installation)
      req.tenantId = authContext ? authContext.tenantId : null;
      req.branchId = authContext ? authContext.branchId : null;
    }

    return next();
  } catch (err) {
    console.error('[tenantResolver] failed to resolve tenant context', err);
    return res.status(500).json({ error: 'Internal error resolving tenant context.' });
  }
}

/**
 * Route guard to require that a tenant was actually resolved — use on
 * any tenant-scoped router that must not run unscoped.
 */
function requireTenant(req, res, next) {
  if (!req.tenantId) {
    return res.status(400).json({ error: 'Tenant context is required for this endpoint.' });
  }
  return next();
}

/**
 * Require a logged-in user session (authUser context).
 */
function requireAuth(req, res, next) {
  if (!req.authUser) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  return next();
}

/**
 * Require specific user roles.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.authUser) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    if (!roles.includes(req.authUser.role)) {
      return res.status(403).json({ error: 'Forbidden. You do not have permission.' });
    }
    return next();
  };
}

module.exports = { tenantResolver, requireTenant, extractSubdomain, requireAuth, requireRole };
