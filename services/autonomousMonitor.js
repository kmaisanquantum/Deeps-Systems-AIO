// =====================================================================
// services/autonomousMonitor.js
// Safe Read-Only Autonomous Monitor lifecycle
// =====================================================================
'use strict';

const db = require('../db');
const eventDispatcher = require('./eventDispatcher');
const financeController = require('../controllers/financeController');
const feesController = require('../controllers/feesController');
const devopsController = require('../controllers/devopsController');
const storeController = require('../controllers/storeController');

let monitorIntervalId = null;

function createCapturingResponse() {
  const capture = { statusCode: 200, body: null };
  return {
    capture,
    status(code) {
      capture.statusCode = code;
      return this;
    },
    json(payload) {
      capture.body = payload;
      return this;
    },
    sendStatus(code) {
      capture.statusCode = code;
      capture.body = null;
      return this;
    },
  };
}

async function runMonitorTick() {
  console.log('[autonomousMonitor] Starting monitor tick...');
  try {
    const tenantsRes = await db.query('SELECT id, name FROM tenants WHERE is_active = true');
    const tenants = tenantsRes.rows;

    for (const tenant of tenants) {
      const tenantId = tenant.id;

      // Simulated superadmin system identity
      const fakeReq = {
        tenantId,
        authUser: { userId: 'system-monitor', role: 'superadmin' },
        body: {},
        params: {},
        query: {},
      };

      // 1. Query financeController.getFinanceSummary
      const financeRes = createCapturingResponse();
      try {
        await financeController.getFinanceSummary(fakeReq, financeRes);
        const summary = financeRes.capture.body;
        if (summary && summary.netCashflow !== undefined && summary.netCashflow < 0) {
          await eventDispatcher.dispatchAsync('autonomous.alert', tenantId, {
            type: 'NEGATIVE_CASHFLOW',
            detail: `Negative net cashflow detected for tenant "${tenant.name}": PGK ${summary.netCashflow}`
          });
        }
      } catch (err) {
        console.warn(`[autonomousMonitor] finance check failed for tenant ${tenantId}:`, err.message);
      }

      // 2. Query feesController.listFees
      const feesRes = createCapturingResponse();
      try {
        await feesController.listFees(fakeReq, feesRes);
        const fees = feesRes.capture.body;
        if (Array.isArray(fees)) {
          const outstanding = fees.filter(f => f.status === 'PENDING');
          if (outstanding.length > 3) {
            await eventDispatcher.dispatchAsync('autonomous.alert', tenantId, {
              type: 'OUTSTANDING_FEES',
              detail: `High count of outstanding service fee invoices detected: ${outstanding.length} pending`
            });
          }
        }
      } catch (err) {
        console.warn(`[autonomousMonitor] fees check failed for tenant ${tenantId}:`, err.message);
      }

      // 3. Query devopsController.listNodes & syncNode
      const nodesRes = createCapturingResponse();
      try {
        await devopsController.listNodes(fakeReq, nodesRes);
        const nodes = nodesRes.capture.body;
        if (Array.isArray(nodes)) {
          for (const node of nodes) {
            // Safely execute syncNode as a non-destructive status refresh
            const syncReq = {
              tenantId,
              authUser: { userId: 'system-monitor', role: 'superadmin' },
              params: { id: node.id },
              body: {},
              query: {},
            };
            const syncRes = createCapturingResponse();
            await devopsController.syncNode(syncReq, syncRes);

            const syncedNode = syncRes.capture.body;
            if (syncedNode && syncedNode.status === 'failed') {
              await eventDispatcher.dispatchAsync('autonomous.alert', tenantId, {
                type: 'OFFLINE_NODE',
                detail: `Infrastructure node "${node.name}" is OFFLINE or connectivity sync check failed.`
              });
            }
          }
        }
      } catch (err) {
        console.warn(`[autonomousMonitor] devops check failed for tenant ${tenantId}:`, err.message);
      }

      // 4. Query storeController connected sites
      const sitesRes = createCapturingResponse();
      try {
        await storeController.listSites(fakeReq, sitesRes);
        const sites = sitesRes.capture.body;
        if (Array.isArray(sites)) {
          const offlineSites = sites.filter(s => s.last_status === 'offline');
          if (offlineSites.length > 0) {
            await eventDispatcher.dispatchAsync('autonomous.alert', tenantId, {
              type: 'OFFLINE_CONNECTED_SITE',
              detail: `${offlineSites.length} connected sites are currently marked as OFFLINE.`
            });
          }
        }
      } catch (err) {
        console.warn(`[autonomousMonitor] store check failed for tenant ${tenantId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[autonomousMonitor] Operational tick encountered error:', err.message);
  }
}

function startAutonomousMonitor() {
  if (process.env.AUTONOMOUS_MONITOR_ENABLED !== 'true') {
    console.log('[autonomousMonitor] Autonomous monitor is disabled.');
    return null;
  }

  const intervalMs = parseInt(process.env.AUTONOMOUS_MONITOR_INTERVAL_MS, 10) || 900000;
  console.log(`[autonomousMonitor] Starting background autonomous monitor on interval: ${intervalMs}ms`);

  // Run immediately on start, then set interval
  runMonitorTick();

  monitorIntervalId = setInterval(runMonitorTick, intervalMs);
  return monitorIntervalId;
}

function stopAutonomousMonitor() {
  if (monitorIntervalId) {
    console.log('[autonomousMonitor] Gracefully halting background monitoring loop.');
    clearInterval(monitorIntervalId);
    monitorIntervalId = null;
  }
}

module.exports = {
  startAutonomousMonitor,
  stopAutonomousMonitor,
  runMonitorTick
};
