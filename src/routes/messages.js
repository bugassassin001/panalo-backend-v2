import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { v4 as uuid } from 'uuid';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { logger } from '../lib/logger.js';

const router = Router();
router.use(requireAuth);

// Helper: load a task + the requesting user's display name in one place.
// Returns { task, senderName } or { error, status }.
async function authorizeAndLoad(taskId, user) {
  // Pull the task with both client and agent joined so we can also notify them.
  // Supabase needs the explicit FK name because there are two relationships
  // between tasks and users (client_id and agent_id).
  const { data: task, error: taskErr } = await supabase
    .from('tasks')
    .select(
      '*, ' +
      'client:users!tasks_client_id_fkey(id, first_name, last_name, email), ' +
      'agent:users!tasks_agent_id_fkey(id, first_name, last_name, email)'
    )
    .eq('id', taskId)
    .single();

  if (taskErr || !task) return { error: 'Task not found', status: 404 };

  // Authz — agents see tasks assigned to them, clients see their own, admins see all
  if (user.role === 'client' && task.client_id !== user.id) {
    return { error: 'Access denied', status: 403 };
  }
  if (user.role === 'agent' && task.agent_id !== user.id) {
    return { error: 'Access denied', status: 403 };
  }

  // Look up the requester's display name (not on JWT, must hit DB)
  const { data: me } = await supabase
    .from('users')
    .select('first_name, last_name, email')
    .eq('id', user.id)
    .single();
  const senderName = me
    ? (`${me.first_name || ''} ${me.last_name || ''}`.trim() || me.email)
    : user.email;

  return { task, senderName };
}

// ── GET /api/messages/:taskId ────────────────────────────────────────────────
// Returns all messages for a task, in chronological order.
// Also marks all messages from the OTHER party as read by the current user.
router.get('/:taskId', asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const auth = await authorizeAndLoad(taskId, req.user);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { data: messages, error } = await supabase
    .from('messages')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('GET messages failed', { taskId, error: error.message });
    return res.status(500).json({ error: 'Could not load messages' });
  }

  // Mark "the other side's" messages as read by me. Fire-and-forget.
  const nowIso = new Date().toISOString();
  if (req.user.role === 'client') {
    supabase.from('messages')
      .update({ read_by_client_at: nowIso })
      .eq('task_id', taskId)
      .neq('sender_type', 'client')
      .is('read_by_client_at', null)
      .then(() => {}, () => {});
  } else if (req.user.role === 'agent' || req.user.role === 'admin') {
    supabase.from('messages')
      .update({ read_by_agent_at: nowIso })
      .eq('task_id', taskId)
      .eq('sender_type', 'client')
      .is('read_by_agent_at', null)
      .then(() => {}, () => {});
  }

  res.json({ messages: messages || [] });
}));

// ── POST /api/messages/:taskId ───────────────────────────────────────────────
router.post('/:taskId', [
  body('body').notEmpty().trim().isLength({ max: 2000 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0]?.msg || 'Invalid input' });
  }

  const { taskId } = req.params;
  const { body: messageBody } = req.body;

  const auth = await authorizeAndLoad(taskId, req.user);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { task, senderName } = auth;

  // Build the row. Mark it pre-read by the sender (no point unreading your own).
  const nowIso = new Date().toISOString();
  const row = {
    id:          uuid(),
    task_id:     taskId,
    sender_id:   req.user.id,
    sender_type: req.user.role,
    sender_name: senderName,
    body:        messageBody,
    read_by_client_at: req.user.role === 'client' ? nowIso : null,
    read_by_agent_at:  (req.user.role === 'agent' || req.user.role === 'admin') ? nowIso : null,
    created_at:  nowIso,
  };

  const { data: message, error } = await supabase
    .from('messages')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error('POST message failed', { taskId, error: error.message });
    return res.status(500).json({ error: 'Could not send message' });
  }

  /* No immediate email on every message — the message notifier worker
     (src/workers/messageNotifier.js) runs every minute and sends a single
     batched notification 15 minutes after the recipient hasn't read it,
     with a 1-email-per-task-per-hour cooldown. See its file for details. */

  logger.info('Message sent', { taskId, senderRole: req.user.role, msgId: message.id });
  res.status(201).json({ message });
}));

// ── GET /api/messages/inbox/all ──────────────────────────────────────────────
// All tasks the user has messages on, with the latest message + unread count.
router.get('/inbox/all', asyncHandler(async (req, res) => {
  let q = supabase
    .from('tasks')
    .select('id, title, status, handler, messages(id, body, sender_type, sender_name, read_by_client_at, read_by_agent_at, created_at)')
    .order('created_at', { ascending: false });

  if (req.user.role === 'client') q = q.eq('client_id', req.user.id);
  if (req.user.role === 'agent')  q = q.eq('agent_id',  req.user.id);
  // admin: no filter

  const { data: tasks, error } = await q;
  if (error) {
    logger.error('inbox failed', { error: error.message });
    return res.status(500).json({ error: 'Could not load inbox' });
  }

  const inbox = (tasks || [])
    .filter(t => t.messages?.length > 0)
    .map(t => {
      const sorted = [...t.messages].sort((a, b) =>
        new Date(a.created_at) - new Date(b.created_at)
      );
      const last = sorted[sorted.length - 1];
      let unread = 0;
      if (req.user.role === 'client') {
        unread = sorted.filter(m => m.sender_type !== 'client' && !m.read_by_client_at).length;
      } else {
        unread = sorted.filter(m => m.sender_type === 'client' && !m.read_by_agent_at).length;
      }
      return {
        task_id:       t.id,
        task_title:    t.title,
        task_status:   t.status,
        task_handler:  t.handler,
        last_message:  last,
        message_count: sorted.length,
        unread_count:  unread,
      };
    });

  res.json({ inbox });
}));

export default router;