const express = require('express');
const router = express.Router();

const devopsController = require('../controllers/devopsController');

// requireTenant middleware stub - assumes it checks auth and sets req.tenantId
function requireTenant(req, res, next) {
  if (!req.tenantId) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      try {
        const base64Url = token.split('.')[1];
        if (base64Url) {
          const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
          const payload = JSON.parse(Buffer.from(base64, 'base64').toString());
          req.tenantId = payload.tenantId || payload.tenant_id;
        }
      } catch (e) {
        // Keep it silent and let next check handle validation
      }
    }
  }

  if (!req.tenantId) {
    req.tenantId = req.headers['x-tenant-id'];
  }

  if (!req.tenantId) {
    return res.status(401).json({ error: 'Unauthorized: Tenant context required' });
  }
  next();
}

// DevOps Routes
router.get('/devops/nodes', requireTenant, devopsController.listNodes);
router.post('/devops/nodes', requireTenant, devopsController.createNode);
router.patch('/devops/nodes/:id', requireTenant, devopsController.updateNode);
router.patch('/devops/nodes/:id/sync', requireTenant, devopsController.syncNode);
router.get('/devops/providers/:provider/resources', requireTenant, devopsController.listProviderResources);

// Attach middleware for exports, but default export is the router itself
router.requireTenant = requireTenant;

module.exports = router;
