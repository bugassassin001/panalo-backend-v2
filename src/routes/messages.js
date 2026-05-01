import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { v4 as uuid } from 'uuid';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { sendAgentMessageEmail } from '../lib/email.js';
import { logger } from '../lib/logger.js';

const router = Router();
router.use(requireAuth);

// ── GET /api/messages/:taskId ────────────────────────────────────────────────
router.get('/:taskId', asyncHandler(async (req, res) => {
  const { taskId } = req.params;

  // Verify access to this task
  const { data: task } = await supabase.from('tasks').select('user_id, agent_id').eq('id', taskId).single();
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (req.user.role === 'client' && task.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (req.user.role === 'agent' && task.agent_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { data: messages, error } = await supabase
    .from('messages')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  res.json({ messages });
}));

// ── POST /api/messages/:taskId ───────────────────────────────────────────────
router.post('/:taskId', [
  body('body').notEmpty().trim().isLength({ max: 2000 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { taskId } = req.params;
  const { body: messageBody } = req.body;

  // Verify access
  const { data: task, error: taskErr } = await supabase
    .from('tasks')
    .select('*, users(email, first_name)')
    .eq('id', taskId)
    .single();

  if (taskErr || !task) return res.status(404).json({ error: 'Task not found' });
  if (req.user.role === 'client' && task.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { data: message, error } = await supabase
    .from('messages')
    .insert({
      id:          uuid(),
      task_id:     taskId,
      sender_id:   req.user.id,
      sender_type: req.user.role,
      sender_name: `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || req.user.email,
      body:        messageBody,
      created_at:  new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw error;

  // If agent is messaging — notify client via email
  if (['agent', 'admin'].includes(req.user.role) && task.users?.email) {
    sendAgentMessageEmail(task.users, task, messageBody)
      .catch(err => logger.warn('Agent message email failed', { error: err.message }));
  }

  logger.info('Message sent', { taskId, senderRole: req.user.role, msgId: message.id });
  res.status(201).json({ message });
}));

// ── GET /api/messages/inbox/all ──────────────────────────────────────────────
// Get all tasks with unread messages for the current user
router.get('/inbox/all', asyncHandler(async (req, res) => {
  let q = supabase
    .from('tasks')
    .select('id, title, status, messages(id, body, sender_type, created_at)')
    .order('created_at', { ascending: false });

  if (req.user.role === 'client') q = q.eq('user_id', req.user.id);
  if (req.user.role === 'agent')  q = q.eq('agent_id', req.user.id);

  const { data: tasks, error } = await q;
  if (error) throw error;

  // Filter to tasks that have messages
  const inbox = (tasks || [])
    .filter(t => t.messages?.length > 0)
    .map(t => ({
      task_id:      t.id,
      task_title:   t.title,
      task_status:  t.status,
      last_message: t.messages[t.messages.length - 1],
      message_count: t.messages.length,
    }));

  res.json({ inbox });
}));

export default router;
