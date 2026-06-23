import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

// ── GET /api/admin/overview ───────────────────────────────────────────────────
router.get('/overview', asyncHandler(async (_req, res) => {
  const now = new Date();
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
  const todayIso     = startOfToday.toISOString();
  const yesterdayIso = startOfYesterday.toISOString();

  const [tasksRes, agentsRes, clientsRes] = await Promise.all([
    // Pull a wider field set so we can compute handle-time and type breakdown.
    // For a small dataset this is fine; if tasks grows large, we'd add filters.
    supabase.from('tasks')
      .select('id, status, handler, type, created_at, updated_at, completed_at, agent_id'),
    supabase.from('users').select('id, agent_status, agent_current_tasks').eq('role', 'agent'),
    supabase.from('users').select('id, plan, created_at').eq('role', 'client'),
  ]);

  const tasks   = tasksRes.data   || [];
  const agents  = agentsRes.data  || [];
  const clients = clientsRes.data || [];

  // ── Today vs yesterday ────────────────────────────────────────────────────
  const todayTasks     = tasks.filter(t => t.created_at >= todayIso);
  const yesterdayTasks = tasks.filter(t => t.created_at >= yesterdayIso && t.created_at < todayIso);

  // % change vs yesterday — null when yesterday was zero (can't divide; "—" in UI)
  const yesterdayCount = yesterdayTasks.length;
  const todayCount     = todayTasks.length;
  const taskDeltaPct = yesterdayCount > 0
    ? Math.round(((todayCount - yesterdayCount) / yesterdayCount) * 100)
    : null;

  // ── AI vs Human (today's tasks, for the donut + KPI tiles) ───────────────
  const aiToday    = todayTasks.filter(t => t.handler === 'ai').length;
  const humanToday = todayTasks.filter(t => t.handler === 'human').length;
  const aiRateToday = todayCount > 0 ? Math.round((aiToday / todayCount) * 100) : 0;

  // Lifetime AI rate (used in the donut sub-label as context)
  const aiResolvedAll  = tasks.filter(t => t.handler === 'ai' && t.status === 'completed').length;
  const totalDoneAll   = tasks.filter(t => t.status === 'completed').length;
  const aiRateLifetime = totalDoneAll > 0 ? Math.round((aiResolvedAll / totalDoneAll) * 100) : 0;

  // ── Tasks by type (today) ─────────────────────────────────────────────────
  // Returns object keyed by type → count. Frontend sorts and slices.
  const byType = {};
  for (const t of todayTasks) {
    const key = (t.type || 'other').toLowerCase();
    byType[key] = (byType[key] || 0) + 1;
  }
  // Array form for ordered iteration in the bar chart
  const tasksByType = Object.entries(byType)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  // ── Average handle time (completed today, human-handled) ─────────────────
  // Measured: completed_at - created_at, in minutes
  const completedTodayWithTimes = todayTasks.filter(t =>
    t.status === 'completed' && t.handler === 'human' && t.completed_at && t.created_at
  );
  let avgHandleMin = null;
  if (completedTodayWithTimes.length > 0) {
    const totalMs = completedTodayWithTimes.reduce((sum, t) => {
      return sum + (new Date(t.completed_at).getTime() - new Date(t.created_at).getTime());
    }, 0);
    avgHandleMin = Math.round(totalMs / completedTodayWithTimes.length / 60000);
  }

  res.json({
    overview: {
      // KPI tiles
      tasks_today:        todayCount,
      tasks_yesterday:    yesterdayCount,
      task_delta_pct:     taskDeltaPct,            // null when yesterday was 0
      ai_resolved_today:  aiToday,
      human_handled_today: humanToday,
      ai_rate_today:      aiRateToday,             // 0-100
      ai_rate_lifetime:   aiRateLifetime,          // 0-100
      agents_online:      agents.filter(a => a.agent_status === 'online').length,
      agents_total:       agents.length,
      total_clients:      clients.length,
      active_tasks:       tasks.filter(t => ['pending','active','review'].includes(t.status)).length,
      avg_handle_min:     avgHandleMin,            // null when nothing completed today
      // Chart data
      tasks_by_type:      tasksByType,             // [{type:'research', count: 12}, ...]
      // Legacy fields kept for back-compat with any older callers
      ai_resolved:        aiResolvedAll,
      human_handled:      tasks.filter(t => t.handler === 'human').length,
      ai_rate:            aiRateLifetime,
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
// Lists clients that have submitted at least one task (lifetime). For each
// client we compute: tasks in last 30 days, AI rate of those tasks, and a
// derived "status" (active if any task in last 30 days, else inactive).
router.get('/clients', asyncHandler(async (_req, res) => {
  // 1. All client users — we'll filter to those with tasks below
  const { data: users, error: usersErr } = await supabase
    .from('users')
    .select('id, first_name, last_name, email, company, plan, created_at, last_login')
    .eq('role', 'client');

  if (usersErr) throw usersErr;

  // 2. Pull every task that has a client_id with the fields needed for stats.
  //    A single query + in-memory aggregation is simpler than multiple per-user
  //    queries, and tasks volume is small enough at this stage.
  const { data: tasks, error: tasksErr } = await supabase
    .from('tasks')
    .select('client_id, handler, created_at')
    .not('client_id', 'is', null);

  if (tasksErr) throw tasksErr;

  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  // Aggregate per client
  const statsByClient = new Map(); // client_id -> { total, recent, aiRecent, lastTaskAt }
  for (const t of tasks || []) {
    const created = t.created_at ? new Date(t.created_at).getTime() : 0;
    const isRecent = created && (now - created) <= THIRTY_DAYS_MS;
    const s = statsByClient.get(t.client_id) || { total: 0, recent: 0, aiRecent: 0, lastTaskAt: null };
    s.total += 1;
    if (isRecent) {
      s.recent += 1;
      if (t.handler === 'ai') s.aiRecent += 1;
    }
    if (!s.lastTaskAt || created > s.lastTaskAt) s.lastTaskAt = created;
    statsByClient.set(t.client_id, s);
  }

  // Build final list — ONLY clients with at least 1 task ever
  const clientsWithTasks = (users || [])
    .filter(u => statsByClient.has(u.id))
    .map(u => {
      const s = statsByClient.get(u.id);
      const aiRate = s.recent > 0 ? Math.round((s.aiRecent / s.recent) * 100) : null;
      const isActive = s.lastTaskAt && (now - s.lastTaskAt) <= THIRTY_DAYS_MS;
      return {
        id:           u.id,
        first_name:   u.first_name || '',
        last_name:    u.last_name || '',
        name:         `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
        email:        u.email,
        company:      u.company || null,
        plan:         u.plan || 'starter',
        tasks_30d:    s.recent,
        ai_rate_30d:  aiRate,         // null when no recent tasks
        total_tasks:  s.total,
        status:       isActive ? 'active' : 'inactive',
        last_task_at: s.lastTaskAt ? new Date(s.lastTaskAt).toISOString() : null,
        last_login:   u.last_login,
        created_at:   u.created_at,
      };
    })
    // Most recently active first
    .sort((a, b) => {
      const at = a.last_task_at ? new Date(a.last_task_at).getTime() : 0;
      const bt = b.last_task_at ? new Date(b.last_task_at).getTime() : 0;
      return bt - at;
    });

  res.json({ clients: clientsWithTasks });
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

// ── PATCH /api/admin/tasks/:id/priority ──────────────────────────────────────
// Admin sets a task's priority. The agent's dashboard polls every few seconds
// and re-renders, so the change appears in their queue automatically (the
// Urgent tab in the agent UI filters on this field).
router.patch('/tasks/:id/priority', asyncHandler(async (req, res) => {
  const ALLOWED = ['low', 'normal', 'urgent'];
  const priority = String(req.body?.priority || '').toLowerCase();

  if (!ALLOWED.includes(priority)) {
    return res.status(400).json({
      error: `Invalid priority. Must be one of: ${ALLOWED.join(', ')}.`,
    });
  }

  const { data, error } = await supabase
    .from('tasks')
    .update({
      priority,
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: 'Could not update task priority' });
  }
  if (!data) {
    return res.status(404).json({ error: 'Task not found' });
  }

  res.json({ message: 'Priority updated', task: data });
}));

export default router;