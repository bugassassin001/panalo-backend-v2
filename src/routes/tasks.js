import { Router } from 'express';
import { body, query, param, validationResult } from 'express-validator';
import { v4 as uuid } from 'uuid';
import { supabase } from '../lib/supabase.js';
import { previewTask } from '../lib/anthropic.js';
import { enqueueTask } from '../workers/taskQueue.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { logger } from '../lib/logger.js';

const router = Router();

// All task routes require authentication
router.use(requireAuth);

// ── GET /api/tasks ───────────────────────────────────────────────────────────
router.get('/', [
  query('status').optional().isIn(['pending','processing','assigned','completed','cancelled']),
  query('handler').optional().isIn(['ai','human']),
  query('type').optional().isString(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
], asyncHandler(async (req, res) => {
  const { status, handler, type, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let q = supabase
    .from('tasks')
    .select('*, task_results(*), agents(name, avatar_url)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  // Clients only see their own tasks; admins/agents see all
  if (req.user.role === 'client') q = q.eq('user_id', req.user.id);

  if (status)  q = q.eq('status', status);
  if (handler) q = q.eq('handler', handler);
  if (type)    q = q.eq('type', type);

  const { data: tasks, count, error } = await q;
  if (error) throw error;

  res.json({
    tasks,
    pagination: {
      total: count,
      page:  parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(count / parseInt(limit)),
    },
  });
}));

// ── GET /api/tasks/:id ───────────────────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const { data: task, error } = await supabase
    .from('tasks')
    .select('*, task_results(*), agents(id,name,avatar_url,email), users(first_name,last_name,email,company)')
    .eq('id', req.params.id)
    .single();

  if (error || !task) return res.status(404).json({ error: 'Task not found' });

  // Clients can only see their own tasks
  if (req.user.role === 'client' && task.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  res.json({ task });
}));

// ── POST /api/tasks ──────────────────────────────────────────────────────────
router.post('/', [
  body('title').notEmpty().trim().isLength({ max: 200 }),
  body('description').optional().trim(),
  body('type').optional().isIn(['research','scheduling','writing','data_entry','transcription','customer_support','other']),
  body('priority').optional().isIn(['low','normal','urgent']),
  body('due_date').optional().isISO8601(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { title, description, type, priority = 'normal', due_date } = req.body;

  // Check task limit for plan
  const { count: monthCount } = await supabase
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', req.user.id)
    .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString());

  const limits = { starter: 50, pro: 200, enterprise: Infinity };
  const limit  = limits[req.user.plan] || 50;

  if (monthCount >= limit) {
    return res.status(429).json({
      error: `Task limit reached for ${req.user.plan} plan (${limit} tasks/month). Please upgrade.`,
      code:  'TASK_LIMIT_REACHED',
    });
  }

  const taskId = uuid();
  const { data: task, error } = await supabase
    .from('tasks')
    .insert({
      id:          taskId,
      user_id:     req.user.id,
      title,
      description: description || null,
      type:        type || 'other',
      priority,
      due_date:    due_date || null,
      status:      'pending',
      handler:     null,
      created_at:  new Date().toISOString(),
      updated_at:  new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    logger.error('Task creation failed', { userId: req.user.id, error: error.message });
    throw error;
  }

  logger.info('Task created', { taskId, userId: req.user.id, title, priority });

  // Queue for AI processing
  await enqueueTask(taskId);

  res.status(201).json({
    message: 'Task submitted successfully. AI is processing it now.',
    task,
  });
}));

// ── PATCH /api/tasks/:id ─────────────────────────────────────────────────────
router.patch('/:id', [
  body('status').optional().isIn(['pending','processing','assigned','completed','cancelled']),
  body('priority').optional().isIn(['low','normal','urgent']),
], asyncHandler(async (req, res) => {
  const { data: task } = await supabase.from('tasks').select().eq('id', req.params.id).single();
  if (!task) return res.status(404).json({ error: 'Task not found' });

  // Clients can only cancel their own pending tasks
  if (req.user.role === 'client') {
    if (task.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (req.body.status && req.body.status !== 'cancelled') {
      return res.status(403).json({ error: 'Clients can only cancel tasks' });
    }
  }

  const updates = { updated_at: new Date().toISOString() };
  if (req.body.status)   updates.status   = req.body.status;
  if (req.body.priority) updates.priority = req.body.priority;
  if (req.body.status === 'completed') updates.completed_at = new Date().toISOString();

  const { data: updated, error } = await supabase
    .from('tasks').update(updates).eq('id', req.params.id).select().single();

  if (error) throw error;
  res.json({ task: updated });
}));

// ── DELETE /api/tasks/:id (cancel) ───────────────────────────────────────────
router.delete('/:id', asyncHandler(async (req, res) => {
  const { data: task } = await supabase.from('tasks').select().eq('id', req.params.id).single();
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (req.user.role === 'client' && task.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!['pending','processing'].includes(task.status)) {
    return res.status(400).json({ error: 'Cannot cancel a task that is already assigned or completed' });
  }
  await supabase.from('tasks').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', req.params.id);
  res.json({ message: 'Task cancelled' });
}));

// ── POST /api/tasks/preview ──────────────────────────────────────────────────
// AI preview for task submission UI — no task saved
router.post('/preview', [
  body('description').notEmpty().isLength({ min: 15, max: 1000 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const preview = await previewTask(req.body.description);
  res.json({ preview });
}));

// ── GET /api/tasks/stats/summary ─────────────────────────────────────────────
router.get('/stats/summary', asyncHandler(async (req, res) => {
  const userId = req.user.role === 'client' ? req.user.id : null;
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

  let baseQ = supabase.from('tasks').select('status,handler,created_at', { count: 'exact' });
  if (userId) baseQ = baseQ.eq('user_id', userId);

  const { data: allTasks } = await baseQ;
  const monthTasks = allTasks?.filter(t => t.created_at >= startOfMonth) || [];

  const stats = {
    total:         allTasks?.length || 0,
    this_month:    monthTasks.length,
    completed:     allTasks?.filter(t => t.status === 'completed').length || 0,
    active:        allTasks?.filter(t => ['pending','processing','assigned'].includes(t.status)).length || 0,
    ai_completed:  allTasks?.filter(t => t.handler === 'ai' && t.status === 'completed').length || 0,
    human_handled: allTasks?.filter(t => t.handler === 'human').length || 0,
    ai_rate:       0,
  };

  if (stats.completed > 0) {
    stats.ai_rate = Math.round((stats.ai_completed / stats.completed) * 100);
  }

  res.json({ stats });
}));

export default router;
