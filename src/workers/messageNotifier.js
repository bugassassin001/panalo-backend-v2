/**
 * Message Notifier — background job that sends batched email notifications
 * for chat messages that remained unread for >15 minutes.
 *
 * Design (per Jordan's spec):
 *   • 15-minute delay before notifying
 *   • One email per task per hour (cooldown)
 *   • Both directions (client ↔ agent)
 *   • Batched: one email summarizing all unread messages on the task
 *
 * Flow (runs every minute):
 *   1. Find messages where:
 *        - created_at <= now - 15 min
 *        - notification_email_sent_at IS NULL
 *        - read_by_<other_party>_at IS NULL
 *   2. Group by task_id
 *   3. For each task, find the recipient
 *   4. Skip if a notification was already sent for this task in the last hour
 *   5. Send ONE email summarizing the unread messages
 *   6. Mark all those messages with notification_email_sent_at = now
 */

import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { sendChatNotificationEmail } from '../lib/email.js';

/* ── Tuning constants ─────────────────────────────────────── */
const NOTIFY_DELAY_MIN     = 15;          // wait this long before emailing
const PER_TASK_COOLDOWN_MIN = 60;          // max 1 email per task per hour
const SCAN_INTERVAL_MS     = 60 * 1000;   // worker tick interval

let _scanTimer = null;

export function startMessageNotifier() {
  if (_scanTimer) return; // already started

  logger.info('📧 Message notifier started', {
    delayMin: NOTIFY_DELAY_MIN,
    cooldownMin: PER_TASK_COOLDOWN_MIN,
  });

  /* Run once on startup, then on a fixed interval. */
  scanForNotifications().catch(err =>
    logger.error('First notifier scan failed', { error: err.message })
  );
  _scanTimer = setInterval(() => {
    scanForNotifications().catch(err =>
      logger.error('Notifier scan failed', { error: err.message })
    );
  }, SCAN_INTERVAL_MS);
}

export function stopMessageNotifier() {
  if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
}

async function scanForNotifications() {
  const now = Date.now();
  const cutoffIso = new Date(now - NOTIFY_DELAY_MIN * 60 * 1000).toISOString();

  /* Find candidate messages — older than the delay, not yet emailed.
     We don't filter by "unread" at the SQL level because the column varies
     by recipient role; we filter in JS once we know the recipient. */
  const { data: candidates, error } = await supabase
    .from('messages')
    .select(`
      id, task_id, sender_id, sender_type, sender_name, body, created_at,
      read_by_client_at, read_by_agent_at
    `)
    .is('notification_email_sent_at', null)
    .lte('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .limit(500); // safety cap per scan

  if (error) {
    logger.error('Notifier query failed', { error: error.message });
    return;
  }
  if (!candidates || candidates.length === 0) return;

  /* Group by task_id */
  const byTask = new Map();
  for (const m of candidates) {
    if (!byTask.has(m.task_id)) byTask.set(m.task_id, []);
    byTask.get(m.task_id).push(m);
  }

  /* Load all involved tasks with client + agent info in one query */
  const taskIds = [...byTask.keys()];
  const { data: tasks, error: tErr } = await supabase
    .from('tasks')
    .select(
      'id, title, ' +
      'client:users!tasks_client_id_fkey(id, first_name, last_name, email), ' +
      'agent:users!tasks_agent_id_fkey(id, first_name, last_name, email)'
    )
    .in('id', taskIds);

  if (tErr) {
    logger.error('Notifier task load failed', { error: tErr.message });
    return;
  }
  const taskById = new Map((tasks || []).map(t => [t.id, t]));

  /* Per task: decide recipient, check unread + cooldown, send email */
  for (const [taskId, messages] of byTask) {
    const task = taskById.get(taskId);
    if (!task) continue;

    await processTaskNotifications(task, messages).catch(err => {
      logger.warn('Notifier per-task failed', {
        taskId, error: err.message,
      });
    });
  }
}

async function processTaskNotifications(task, candidateMessages) {
  /* A task's chat involves the client and (optionally) the assigned agent.
     For each "sender side" we have unread messages from, the OTHER side is
     the recipient. Process each direction separately. */

  const clientMsgsUnreadByAgent = candidateMessages.filter(m =>
    m.sender_type === 'client' && !m.read_by_agent_at
  );
  const agentMsgsUnreadByClient = candidateMessages.filter(m =>
    (m.sender_type === 'agent' || m.sender_type === 'admin') && !m.read_by_client_at
  );

  /* Direction 1: agent(s) → client (unread by client → email the client) */
  if (agentMsgsUnreadByClient.length > 0 && task.client?.email) {
    await maybeNotify({
      task,
      recipient: task.client,
      recipientRole: 'client',
      unreadMessages: agentMsgsUnreadByClient,
    });
  }

  /* Direction 2: client → agent (unread by agent → email the agent) */
  if (clientMsgsUnreadByAgent.length > 0 && task.agent?.email) {
    await maybeNotify({
      task,
      recipient: task.agent,
      recipientRole: 'agent',
      unreadMessages: clientMsgsUnreadByAgent,
    });
  }
}

/* Send the email if cooldown allows; mark all batched messages as notified
   regardless (so they don't get picked up again on the next scan). */
async function maybeNotify({ task, recipient, recipientRole, unreadMessages }) {
  /* Cooldown check: any notification already sent for this task to this
     recipient within the cooldown window? */
  const cooldownIso = new Date(
    Date.now() - PER_TASK_COOLDOWN_MIN * 60 * 1000
  ).toISOString();

  /* "Notified to this recipient" = a notification was sent for a message
     this recipient is the recipient of. We approximate by checking ANY
     notification on this task within the window — simpler and matches the
     spec ("1 email per task per hour"). */
  const { data: recent, error: rcErr } = await supabase
    .from('messages')
    .select('id')
    .eq('task_id', task.id)
    .gte('notification_email_sent_at', cooldownIso)
    .limit(1);

  if (rcErr) {
    logger.warn('Cooldown check failed', {
      taskId: task.id, error: rcErr.message,
    });
    /* Fail-safe: skip sending to avoid double-emails on transient errors */
    return;
  }

  const messageIds = unreadMessages.map(m => m.id);
  const nowIso = new Date().toISOString();

  if (recent && recent.length > 0) {
    /* Cooldown active — still mark these messages as notified so we don't
       re-evaluate them every minute forever. The recipient will see them
       in the dashboard either way; the email simply won't fire this hour. */
    await supabase
      .from('messages')
      .update({ notification_email_sent_at: nowIso })
      .in('id', messageIds);

    logger.info('Notifier: cooldown active, skipping email but marking',  {
      taskId: task.id, recipientRole, count: messageIds.length,
    });
    return;
  }

  /* Send the email */
  try {
    await sendChatNotificationEmail({
      recipient,
      recipientRole,
      task,
      messages: unreadMessages,
    });
  } catch (err) {
    logger.error('Notifier email send failed', {
      taskId: task.id, recipientRole, error: err.message,
    });
    /* Don't mark as notified — let the next scan retry. */
    return;
  }

  /* Mark all batched messages as notified */
  const { error: updErr } = await supabase
    .from('messages')
    .update({ notification_email_sent_at: nowIso })
    .in('id', messageIds);

  if (updErr) {
    logger.warn('Notifier mark-as-sent failed (email did go out)', {
      taskId: task.id, error: updErr.message,
    });
  }

  logger.info('📧 Notification email sent', {
    taskId: task.id, recipientRole, messageCount: messageIds.length,
  });
}
