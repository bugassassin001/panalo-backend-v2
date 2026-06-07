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

  const [tasksRes, agentsRes, clientsRes] = await Promise.all([
    supabase.from('tasks').select('status, handler, created_at, completed_at'),
    // Read agents from the users table (role='agent') — consolidated from the old agents table
    supabase.from('users').select('id, agent_status, agent_current_tasks').eq('role', 'agent'),
    supabase.from('users').select('id, plan, created_at').eq('role', 'client'),
  ]);

  const tasks   = tasksRes.data   || [];
  const agents  = agentsRes.data  || [];
  const clients = clientsRes.data || [];

  const todayTasks    = tasks.filter(t => t.created_at >= todayIso);
  const aiResolved    = tasks.filter(t => t.handler === 'ai' && t.status === 'completed');
  const humanHandled  = tasks.filter(t => t.handler === 'human');
  const totalDone     = tasks.filter(t => t.status === 'completed').length;

  res.json({
    overview: {
      tasks_today:      todayTasks.length,
      ai_resolved:      aiResolved.length,
      human_handled:    humanHandled.length,
      ai_rate:          totalDone ? Math.round(aiResolved.length / totalDone * 100) : 0,
      agents_online:    agents.filter(a => a.agent_status === 'online').length,
      agents_total:     agents.length,
      total_clients:    clients.length,
      active_tasks:     tasks.filter(t => ['pending','active','review'].includes(t.status)).length,
    },
  });
}));

// ── GET /api/admin/agents ─────────────────────────────────────────────────────
// Reads from users WHERE role='agent' (the agents table has been dropped).
// Shape kept similar to the old endpoint so any frontend code that consumed
// it (agent dropdowns, reassign UI) keeps working.
router.get('/agents', asyncHandler(async (_req, res) => {
  const { data: users, error } = await supabase
    .from('users')
    .select('id, first_name, last_name, email, agent_status, agent_current_tasks, last_login, created_at')
    .eq('role', 'agent')
    .order('first_name');

  if (error) throw error;

  // Project users → the agent shape the old endpoint returned
  const agents = (users || []).map(u => ({
    id:             u.id,
    name:           `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
    email:          u.email,
    status:         u.agent_status || 'offline',
    current_tasks:  u.agent_current_tasks || 0,
    last_login:     u.last_login,
    created_at:     u.created_at,
  }));

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
// Assign a task to an agent (or unassign by passing agent_id=null).
// - When assigning: status moves to 'active', handler='human'
// - When unassigning: status moves back to 'review', handler stays 'human'
router.patch('/tasks/:id/reassign', asyncHandler(async (req, res) => {
  const { agent_id } = req.body;

  // Validate the target agent exists and has role='agent'
  if (agent_id) {
    const { data: agent } = await supabase
      .from('users').select('id, role').eq('id', agent_id).single();
    if (!agent || agent.role !== 'agent') {
      return res.status(400).json({ error: 'Invalid agent_id — must reference a user with role=agent' });
    }
  }

  const updates = {
    agent_id: agent_id || null,
    handler:  'human',
    status:   agent_id ? 'active' : 'review',
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('tasks').update(updates).eq('id', req.params.id)
    .select().single();

  if (error) {
    return res.status(500).json({ error: 'Could not reassign task' });
  }

  res.json({ message: agent_id ? 'Task assigned' : 'Task unassigned', task: data });
}));

export default router;
