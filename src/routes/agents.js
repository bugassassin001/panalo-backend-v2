import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { logger } from '../lib/logger.js';

const router = Router();
router.use(requireAuth);

// ── GET /api/agents/queue ─────────────────────────────────────────────────────
// Agent's assigned task queue
router.get('/queue', requireRole('agent','admin'), asyncHandler(async (req, res) => {
  const agentId = req.user.role === 'agent' ? req.user.id : req.query.agent_id;

  let q = supabase
    .from('tasks')
    .select('*, task_results(*), users(first_name, last_name, email, company), messages(id, body, sender_type, created_at)')
    .in('status', ['assigned', 'pending'])
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true });

  if (agentId) q = q.eq('agent_id', agentId);

  const { data: tasks, error } = await q;
  if (error) throw error;

  res.json({
    queue: tasks || [],
    count: tasks?.length || 0,
  });
}));

// ── PATCH /api/agents/tasks/:taskId/accept ────────────────────────────────────
router.patch('/tasks/:taskId/accept', requireRole('agent','admin'), asyncHandler(async (req, res) => {
  const { taskId } = req.params;

  const { data: task } = await supabase.from('tasks').select().eq('id', taskId).single();
  if (!task) return res.status(404).json({ error: 'Task not found' });

  await supabase.from('tasks').update({
    agent_id:   req.user.id,
    status:     'assigned',
    updated_at: new Date().toISOString(),
  }).eq('id', taskId);

  logger.info('Task accepted by agent', { taskId, agentId: req.user.id });
  res.json({ message: 'Task accepted' });
}));

// ── PATCH /api/agents/tasks/:taskId/complete ──────────────────────────────────
router.patch('/tasks/:taskId/complete', requireRole('agent','admin'), [
  body('summary').notEmpty().trim().isLength({ min: 10 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { taskId } = req.params;
  const { summary } = req.body;

  const { data: task } = await supabase
    .from('tasks')
    .select('*, users(email, first_name)')
    .eq('id', taskId)
    .single();

  if (!task) return res.status(404).json({ error: 'Task not found' });

  await Promise.all([
    supabase.from('tasks').update({
      status:       'completed',
      completed_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    }).eq('id', taskId),

    supabase.from('task_results').upsert({
      task_id:    taskId,
      output:     summary,
      handler:    'human',
      agent_id:   req.user.id,
      created_at: new Date().toISOString(),
    }),

    supabase.from('messages').insert({
      task_id:     taskId,
      sender_id:   req.user.id,
      sender_type: 'agent',
      body:        `✅ Task completed!\n\n${summary}`,
      created_at:  new Date().toISOString(),
    }),

    // Decrement agent task count
    supabase.rpc('decrement_agent_tasks', { agent_id: req.user.id }),
  ]);

  logger.info('Task completed by agent', { taskId, agentId: req.user.id });
  res.json({ message: 'Task marked as completed and client notified.' });
}));

// ── PATCH /api/agents/tasks/:taskId/escalate ──────────────────────────────────
router.patch('/tasks/:taskId/escalate', requireRole('agent','admin'), [
  body('reason').notEmpty().trim(),
], asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  await supabase.from('tasks').update({
    status:     'pending', // back to queue
    agent_id:   null,
    updated_at: new Date().toISOString(),
  }).eq('id', taskId);

  await supabase.from('messages').insert({
    task_id:     taskId,
    sender_id:   req.user.id,
    sender_type: 'system',
    body:        `Task escalated to supervisor. Reason: ${req.body.reason}`,
    created_at:  new Date().toISOString(),
  });

  res.json({ message: 'Task escalated to supervisor' });
}));

// ── PATCH /api/agents/status ──────────────────────────────────────────────────
// Agent sets their own online/break/offline status
router.patch('/status', requireRole('agent'), [
  body('status').isIn(['online','break','offline']),
], asyncHandler(async (req, res) => {
  const { status } = req.body;
  await supabase.from('agents').update({
    status,
    updated_at: new Date().toISOString(),
  }).eq('id', req.user.id);

  res.json({ message: `Status updated to ${status}` });
}));

// ── GET /api/agents/metrics ───────────────────────────────────────────────────
router.get('/metrics', requireRole('agent','admin'), asyncHandler(async (req, res) => {
  const agentId = req.user.id;
  const today   = new Date(); today.setHours(0,0,0,0);

  const { data: todayTasks } = await supabase
    .from('tasks')
    .select('status, completed_at')
    .eq('agent_id', agentId)
    .gte('created_at', today.toISOString());

  res.json({
    metrics: {
      completed_today: todayTasks?.filter(t => t.status === 'completed').length || 0,
      active_tasks:    todayTasks?.filter(t => t.status === 'assigned').length || 0,
    },
  });
}));

export default router;
