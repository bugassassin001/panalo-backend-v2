import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import crypto from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { sendTaskCompletedEmail } from '../lib/email.js';
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

// ── PATCH /api/tasks/:id/complete ───────────────────────────────────────────
// Agent marks a task complete. Persists the completion summary as a real chat
// message so the client sees it in their thread. Also sends an email.
router.patch('/:id/complete', requireAuth, [
  body('summary').optional().isString().trim().isLength({ max: 2000 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0]?.msg || 'Invalid input' });
  }
  const { id } = req.params;
  const summary = (req.body.summary || '').trim();

  // Only agents (the assignee) and admins can complete a task.
  if (req.user.role !== 'agent' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only agents can mark tasks complete' });
  }

  // Load the task and authorize
  const { data: task, error: fetchErr } = await supabase
    .from('tasks')
    .select(
      '*, ' +
      'client:users!tasks_client_id_fkey(id, first_name, last_name, email), ' +
      'agent:users!tasks_agent_id_fkey(id, first_name, last_name, email)'
    )
    .eq('id', id)
    .single();

  if (fetchErr || !task) return res.status(404).json({ error: 'Task not found' });
  if (req.user.role === 'agent' && task.agent_id !== req.user.id) {
    return res.status(403).json({ error: 'You are not assigned to this task' });
  }

  // Update the task
  const nowIso = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from('tasks')
    .update({
      status:       'completed',
      completed_at: nowIso,
      completed_by: req.user.id,
      updated_at:   nowIso,
    })
    .eq('id', id)
    .select()
    .single();

  if (updErr) {
    logger.error('Complete task failed', { id, error: updErr.message });
    return res.status(500).json({ error: 'Could not complete task' });
  }

  // Look up the agent's display name (JWT only has email)
  const { data: me } = await supabase.from('users')
    .select('first_name, last_name, email').eq('id', req.user.id).single();
  const agentName = me
    ? (`${me.first_name || ''} ${me.last_name || ''}`.trim() || me.email)
    : req.user.email;

  // Persist a completion message in the messages thread so the client sees it
  // when they open the chat. Use random UUID v4 via crypto.
  const completionMessage = summary
    ? `✅ Task completed!\n\n${summary}\n\nPlease let me know if you need anything else.`
    : `✅ This task has been marked complete. Please let me know if you need anything else.`;

  await supabase.from('messages').insert({
    id:          crypto.randomUUID(),
    task_id:     id,
    sender_id:   req.user.id,
    sender_type: req.user.role,           // 'agent' or 'admin'
    sender_name: agentName,
    body:        completionMessage,
    read_by_agent_at:  nowIso,            // agent obviously knows about their own action
    read_by_client_at: null,              // client should be notified
    created_at:  nowIso,
  });

  // Email the client (best-effort; non-blocking)
  if (task.client?.email) {
    sendTaskCompletedEmail({
      client: task.client,
      task,
      summary,
      agentName,
    }).catch(err => logger.warn('Task completion email failed', { error: err.message }));
  }

  logger.info('Task completed', { taskId: id, agentId: req.user.id });
  res.json({ task: updated, message: 'Task marked complete' });
}));

// ── PATCH /api/tasks/:id/reopen ─────────────────────────────────────────────
// Client can reopen a completed task. Agents/admins can also reopen.
router.patch('/:id/reopen', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { data: task, error: fetchErr } = await supabase
    .from('tasks').select('*').eq('id', id).single();

  if (fetchErr || !task) return res.status(404).json({ error: 'Task not found' });

  // Authz: client must own it, agent must be assigned, admins any
  if (req.user.role === 'client' && task.client_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.user.role === 'agent' && task.agent_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (task.status !== 'completed' && task.status !== 'done') {
    return res.status(400).json({ error: 'Task is not currently completed' });
  }

  const nowIso = new Date().toISOString();
  // Decide what status to return to: if there's still an agent assigned → 'active',
  // otherwise → 'review' (awaiting reassignment).
  const newStatus = task.agent_id ? 'active' : 'review';

  const { data: updated, error: updErr } = await supabase
    .from('tasks').update({
      status:       newStatus,
      completed_at: null,
      completed_by: null,
      updated_at:   nowIso,
    }).eq('id', id).select().single();

  if (updErr) {
    logger.error('Reopen task failed', { id, error: updErr.message });
    return res.status(500).json({ error: 'Could not reopen task' });
  }

  // Look up the requester's name for the system message
  const { data: me } = await supabase.from('users')
    .select('first_name, last_name, email').eq('id', req.user.id).single();
  const whoName = me
    ? (`${me.first_name || ''} ${me.last_name || ''}`.trim() || me.email)
    : req.user.email;

  // Drop a system message so the other party knows it was reopened
  await supabase.from('messages').insert({
    id:          crypto.randomUUID(),
    task_id:     id,
    sender_id:   req.user.id,
    sender_type: 'system',
    sender_name: 'System',
    body:        `${whoName} reopened this task.`,
    read_by_client_at: req.user.role === 'client' ? nowIso : null,
    read_by_agent_at:  (req.user.role === 'agent' || req.user.role === 'admin') ? nowIso : null,
    created_at:  nowIso,
  });

  logger.info('Task reopened', { taskId: id, by: req.user.id, role: req.user.role });
  res.json({ task: updated, message: 'Task reopened' });
}));

export default router;
