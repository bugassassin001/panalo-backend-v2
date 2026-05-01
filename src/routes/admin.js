import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

// ── GET /api/admin/overview ───────────────────────────────────────────────────
router.get('/overview', asyncHandler(async (_req, res) => {
  const today  = new Date(); today.setHours(0,0,0,0);
  const todayIso = today.toISOString();

  const [tasksRes, agentsRes, usersRes] = await Promise.all([
    supabase.from('tasks').select('status, handler, created_at, completed_at'),
    supabase.from('agents').select('status, current_tasks'),
    supabase.from('users').select('id, plan, created_at').eq('role', 'client'),
  ]);

  const tasks  = tasksRes.data  || [];
  const agents = agentsRes.data || [];
  const users  = usersRes.data  || [];

  const todayTasks   = tasks.filter(t => t.created_at >= todayIso);
  const aiResolved   = tasks.filter(t => t.handler === 'ai' && t.status === 'completed');
  const humanHandled = tasks.filter(t => t.handler === 'human');

  res.json({
    overview: {
      tasks_today:      todayTasks.length,
      ai_resolved:      aiResolved.length,
      human_handled:    humanHandled.length,
      ai_rate:          tasks.length ? Math.round(aiResolved.length / tasks.filter(t => t.status === 'completed').length * 100) : 0,
      agents_online:    agents.filter(a => a.status === 'online').length,
      agents_total:     agents.length,
      total_clients:    users.length,
      active_tasks:     tasks.filter(t => ['pending','processing','assigned'].includes(t.status)).length,
    },
  });
}));

// ── GET /api/admin/agents ─────────────────────────────────────────────────────
router.get('/agents', asyncHandler(async (_req, res) => {
  const { data: agents, error } = await supabase
    .from('agents')
    .select('*')
    .order('status')
    .order('name');

  if (error) throw error;
  res.json({ agents });
}));

// ── GET /api/admin/clients ────────────────────────────────────────────────────
router.get('/clients', asyncHandler(async (_req, res) => {
  const { data: clients, error } = await supabase
    .from('users')
    .select('id, first_name, last_name, email, company, plan, created_at, last_login')
    .eq('role', 'client')
    .order('created_at', { ascending: false });

  if (error) throw error;
  res.json({ clients });
}));

// ── PATCH /api/admin/tasks/:id/reassign ───────────────────────────────────────
router.patch('/tasks/:id/reassign', asyncHandler(async (req, res) => {
  const { agent_id } = req.body;
  await supabase.from('tasks').update({
    agent_id,
    status:     'assigned',
    updated_at: new Date().toISOString(),
  }).eq('id', req.params.id);

  res.json({ message: 'Task reassigned' });
}));

export default router;
