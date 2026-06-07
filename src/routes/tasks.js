import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { logger } from '../lib/logger.js';

const router = Router();

// ── GET /api/tasks ───────────────────────────────────────────────────────────
// Returns tasks scoped to the caller's role:
//   - client: their own tasks
//   - agent:  ONLY tasks assigned to them (strict, per design)
//   - admin:  all tasks, enriched with client info
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const role = req.user.role;

  // Different joins per role:
  //  - admin: full JOIN (client + agent info, since they see everyone)
  //  - agent: full JOIN (client + agent info, to display the client)
  //  - client: just agent info (they know they ARE the client)
  let selectCols;
  if (role === 'admin' || role === 'agent') {
    selectCols = '*, ' +
      'client:users!tasks_client_id_fkey(id, first_name, last_name, email, company), ' +
      'agent:users!tasks_agent_id_fkey(id, first_name, last_name, email)';
  } else if (role === 'client') {
    selectCols = '*, agent:users!tasks_agent_id_fkey(id, first_name, last_name, email)';
  } else {
    selectCols = '*';
  }

  let query = supabase.from('tasks').select(selectCols).order('created_at', { ascending: false });

  if (role === 'client') {
    query = query.eq('client_id', req.user.id);
  } else if (role === 'agent') {
    // Strict: agents only see what's assigned to them
    query = query.eq('agent_id', req.user.id);
  }
  // admin: no filter — sees all

  const { data, error } = await query;
  if (error) {
    logger.error('GET /tasks failed', { userId: req.user.id, role, error: error.message });
    // If the join syntax fails, retry without the join so the view at least loads
    if (role === 'admin' || role === 'agent' || role === 'client') {
      let fbq = supabase.from('tasks').select('*').order('created_at', { ascending: false });
      if (role === 'agent')  fbq = fbq.eq('agent_id',  req.user.id);
      if (role === 'client') fbq = fbq.eq('client_id', req.user.id);
      const { data: fallback, error: fbErr } = await fbq;
      if (!fbErr) {
        logger.warn('Tasks join failed, returned raw rows', { role, error: error.message });
        return res.json({ tasks: fallback || [] });
      }
    }
    return res.status(500).json({ error: 'Could not load tasks' });
  }
  logger.info('GET /tasks ok', { userId: req.user.id, role, count: (data || []).length });
  res.json({ tasks: data || [] });
}));

// ── POST /api/tasks ──────────────────────────────────────────────────────────
// Create a new task (clients only)
router.post('/', requireAuth, [
  body('title').isString().trim().isLength({ min: 3, max: 280 }),
  body('description').optional().isString().trim(),
  body('type').optional().isString(),
  body('priority').optional().isIn(['low','normal','urgent']),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  if (req.user.role !== 'client') {
    return res.status(403).json({ error: 'Only clients can submit tasks' });
  }

  const { title, description, type = 'general', priority = 'normal' } = req.body;

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      client_id: req.user.id,
      title,
      description: description || null,
      type,
      priority,
      status: 'pending',
    })
    .select()
    .single();

  if (error) {
    logger.error('POST /tasks failed', { userId: req.user.id, error: error.message });
    return res.status(500).json({ error: 'Could not create task' });
  }

  // Also bump the user's task_count
  await supabase.rpc('increment_task_count', { user_id: req.user.id }).then(() => {}, () => {
    return supabase.from('users')
      .update({ task_count: (req.user.task_count || 0) + 1 })
      .eq('id', req.user.id);
  });

  logger.info('Task created', { taskId: data.id, clientId: req.user.id });
  res.status(201).json({ task: data });
}));

// ── GET /api/tasks/:id ──────────────────────────────────────────────────────
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Task not found' });

  // Authz: clients can only see their own, agents can only see their assigned ones
  if (req.user.role === 'client' && data.client_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.user.role === 'agent' && data.agent_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json({ task: data });
}));

export default router;