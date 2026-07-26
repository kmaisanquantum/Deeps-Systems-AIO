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
const communicationController = require('../controllers/communicationController');

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

      // 5. Study schedule reminders
      if (process.env.HOSTGATOR_SMTP_HOST) {
        try {
          const schedulesRes = await db.query(
            `SELECT * FROM study_schedule
              WHERE tenant_id = $1
                AND scheduled_at IS NOT NULL
                AND reminded_at IS NULL
                AND scheduled_at <= NOW() + (COALESCE(reminder_lead_minutes, 60) || ' minutes')::interval
                AND scheduled_at > NOW()`,
            [tenantId]
          );

          for (const row of schedulesRes.rows) {
            try {
              const start = new Date(row.scheduled_at);
              const duration = row.duration_minutes || 60;
              const end = new Date(start.getTime() + duration * 60 * 1000);

              const formatUTCDate = (date) => {
                return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
              };

              const escapeICS = (str) => {
                if (!str) return '';
                return str
                  .replace(/\\/g, '\\\\')
                  .replace(/;/g, '\\;')
                  .replace(/,/g, '\\,')
                  .replace(/\n/g, '\\n')
                  .replace(/\r/g, '');
              };

              const descriptionParts = [];
              if (row.topic) descriptionParts.push(`Topic: ${row.topic}`);
              if (row.notes) descriptionParts.push(`Notes: ${row.notes}`);
              const description = descriptionParts.join('\n');

              const icsString = [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'PRODID:-//Deeps Systems//Study Schedule Reminder//EN',
                'CALSCALE:GREGORIAN',
                'METHOD:PUBLISH',
                'BEGIN:VEVENT',
                `UID:${row.id}`,
                `DTSTAMP:${formatUTCDate(new Date())}`,
                `DTSTART:${formatUTCDate(start)}`,
                `DTEND:${formatUTCDate(end)}`,
                `SUMMARY:${escapeICS(row.title)}`,
                `DESCRIPTION:${escapeICS(description)}`,
                'END:VEVENT',
                'END:VCALENDAR'
              ].join('\r\n');

              const toAddress = row.reminder_email || 'kmaisan@dspng.tech';
              const subject = `Study Session Reminder: ${row.title}`;
              const message = `This is a reminder for your upcoming study session:\n\nTitle: ${row.title}\nTopic: ${row.topic || 'N/A'}\nScheduled At: ${row.scheduled_at}\nDuration: ${duration} minutes\nNotes: ${row.notes || 'N/A'}\n\nPlease find the attached calendar invite.`;

              const attachments = [
                {
                  filename: 'study.ics',
                  content: icsString,
                  contentType: 'text/calendar'
                }
              ];

              await communicationController.sendEmailMessage(toAddress, subject, message, attachments);

              // Mark as reminded
              await db.query(
                'UPDATE study_schedule SET reminded_at = NOW() WHERE id = $1',
                [row.id]
              );
            } catch (sendErr) {
              console.warn(`[autonomousMonitor] Failed to send reminder email for study schedule ${row.id}:`, sendErr.message);
            }
          }
        } catch (sweepErr) {
          console.warn(`[autonomousMonitor] Study schedule sweep failed for tenant ${tenantId}:`, sweepErr.message);
        }

        // 5.b Streak at risk warning
        try {
          const streakRiskRes = await db.query(
            `SELECT s.id, s.current_streak, s.last_study_date::text,
                    (SELECT COUNT(*)::integer FROM study_session_logs ssl WHERE ssl.tenant_id = s.tenant_id AND ssl.started_at::DATE = CURRENT_DATE) AS today_sessions
               FROM study_streaks s
              WHERE s.tenant_id = $1
                AND s.last_study_date IS NOT NULL
                AND s.last_study_date < CURRENT_DATE
                AND (s.last_warned_date IS NULL OR s.last_warned_date < CURRENT_DATE)`,
            [tenantId]
          );

          if (streakRiskRes.rowCount > 0) {
            const row = streakRiskRes.rows[0];
            const todaySessions = parseInt(row.today_sessions, 10);
            if (todaySessions === 0) {
              // Fetch primary admin email, default to 'kmaisan@dspng.tech'
              const adminRes = await db.query(
                "SELECT email FROM users WHERE tenant_id = $1 AND role = 'admin' LIMIT 1",
                [tenantId]
              );
              const toAddress = adminRes.rowCount > 0 ? adminRes.rows[0].email : 'kmaisan@dspng.tech';

              const subject = `🔥 Study Streak at Risk! Study Today to Keep Your Streak Alive!`;
              const message = `Hi there,\n\nYour current study streak of ${row.current_streak} day(s) is at risk! You haven't started any study sessions today.\n\nLog in now to study and keep your streak alive!\n\nBest regards,\nDeeps Systems Learning Engine`;

              await communicationController.sendEmailMessage(toAddress, subject, message);

              // Mark as warned today
              await db.query(
                "UPDATE study_streaks SET last_warned_date = CURRENT_DATE WHERE id = $1",
                [row.id]
              );
              console.log(`[autonomousMonitor] Sent streak at risk warning email to ${toAddress} for tenant ${tenantId}`);
            }
          }
        } catch (streakRiskErr) {
          console.warn(`[autonomousMonitor] Streak risk sweep failed for tenant ${tenantId}:`, streakRiskErr.message);
        }

        // 5.c Spaced Repetition Reviews Due
        try {
          const dueReviewsRes = await db.query(
            `SELECT COUNT(*)::integer AS count
               FROM review_schedules
              WHERE tenant_id = $1
                AND due_at <= NOW()
                AND completed_at IS NULL`,
            [tenantId]
          );

          const dueCount = dueReviewsRes.rows[0].count;
          if (dueCount > 0) {
            const adminRes = await db.query(
              "SELECT email FROM users WHERE tenant_id = $1 AND role = 'admin' LIMIT 1",
              [tenantId]
            );
            const toAddress = adminRes.rowCount > 0 ? adminRes.rows[0].email : 'kmaisan@dspng.tech';

            const subject = `📚 Spaced Repetition: You Have ${dueCount} Review(s) Due Today!`;
            const message = `Hi there,\n\nYou have ${dueCount} active study review(s) due today to maximize your retention.\n\nLog in now to your Learning Pathway dashboard to complete your reviews and boost your long-term memory!\n\nBest regards,\nDeeps Systems Learning Engine`;

            await communicationController.sendEmailMessage(toAddress, subject, message);
            console.log(`[autonomousMonitor] Sent reviews due today email to ${toAddress} with ${dueCount} reviews for tenant ${tenantId}`);
          }
        } catch (reviewsDueErr) {
          console.warn(`[autonomousMonitor] Reviews due sweep failed for tenant ${tenantId}:`, reviewsDueErr.message);
        }

        // 5.d Congratulate Earned Achievements
        try {
          const unnotifiedAchievementsRes = await db.query(
            `SELECT ua.id, a.title, a.description, a.icon, ua.earned_at
               FROM user_achievements ua
               JOIN achievements a ON ua.achievement_id = a.id
              WHERE ua.tenant_id = $1
                AND ua.notified_at IS NULL`,
            [tenantId]
          );

          for (const row of unnotifiedAchievementsRes.rows) {
            try {
              const adminRes = await db.query(
                "SELECT email FROM users WHERE tenant_id = $1 AND role = 'admin' LIMIT 1",
                [tenantId]
              );
              const toAddress = adminRes.rowCount > 0 ? adminRes.rows[0].email : 'kmaisan@dspng.tech';

              const subject = `🏆 Achievement Unlocked: ${row.icon} ${row.title}!`;
              const message = `Congratulations!\n\nYou have unlocked a new achievement in your Learning Pathway:\n\nAchievement: ${row.icon} ${row.title}\nDescription: ${row.description || 'N/A'}\nEarned At: ${row.earned_at}\n\nKeep up the spectacular work and continue expanding your knowledge!\n\nBest regards,\nDeeps Systems Learning Engine`;

              await communicationController.sendEmailMessage(toAddress, subject, message);

              // Mark as notified
              await db.query(
                'UPDATE user_achievements SET notified_at = NOW() WHERE id = $1',
                [row.id]
              );
              console.log(`[autonomousMonitor] Sent congratulatory email for achievement ${row.title} to ${toAddress} for tenant ${tenantId}`);
            } catch (notifErr) {
              console.warn(`[autonomousMonitor] Failed to send congratulations for achievement ${row.id}:`, notifErr.message);
            }
          }
        } catch (achievementsNotifErr) {
          console.warn(`[autonomousMonitor] Achievements sweep failed for tenant ${tenantId}:`, achievementsNotifErr.message);
        }
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
