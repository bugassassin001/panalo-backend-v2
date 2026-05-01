/**
 * Panalo.ai — Database Seeder
 * Run: node scripts/seed.js
 * Seeds sample agents, a test client, and sample tasks for local development
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function seed() {
  console.log('🌱 Seeding Panalo.ai database...\n');

  // ── Admin user ─────────────────────────────────────────────────────────────
  const adminId = uuid();
  const adminHash = await bcrypt.hash('admin123!', 12);
  const { error: adminErr } = await supabase.from('users').upsert({
    id: adminId, email: 'admin@panalo.ai',
    password_hash: adminHash, first_name: 'JR', last_name: 'Calanoc',
    company: 'Dynamico', role: 'admin', plan: 'enterprise',
    subscription_status: 'active', token_version: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'email' });
  console.log(adminErr ? `❌ Admin: ${adminErr.message}` : '✅ Admin user: admin@panalo.ai / admin123!');

  // ── Test client ────────────────────────────────────────────────────────────
  const clientId = uuid();
  const clientHash = await bcrypt.hash('client123!', 12);
  const { error: clientErr } = await supabase.from('users').upsert({
    id: clientId, email: 'sarah@buildco.com',
    password_hash: clientHash, first_name: 'Sarah', last_name: 'Chen',
    company: 'BuildCo LLC', role: 'client', plan: 'pro',
    subscription_status: 'active', token_version: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'email' });
  console.log(clientErr ? `❌ Client: ${clientErr.message}` : '✅ Test client: sarah@buildco.com / client123!');

  // ── Agents ─────────────────────────────────────────────────────────────────
  const agents = [
    { name: 'Maria Abad',    email: 'maria@panalo.ai',   role: 'senior_agent', location: 'Manila, PH',  status: 'online',  csat: 4.9, completed_today: 12 },
    { name: 'Carlos Domingo',email: 'carlos@panalo.ai',  role: 'agent',        location: 'Cebu, PH',    status: 'online',  csat: 4.7, completed_today: 8  },
    { name: 'Rosa Lim',      email: 'rosa@panalo.ai',    role: 'agent',        location: 'Manila, PH',  status: 'online',  csat: 5.0, completed_today: 15 },
    { name: 'Jose Padilla',  email: 'jose@panalo.ai',    role: 'agent',        location: 'Davao, PH',   status: 'break',   csat: 4.6, completed_today: 6  },
    { name: 'Ana Cruz',      email: 'ana@panalo.ai',     role: 'senior_agent', location: 'Manila, PH',  status: 'online',  csat: 4.8, completed_today: 10 },
  ];

  for (const agent of agents) {
    const agentUserHash = await bcrypt.hash('agent123!', 12);
    const agentUserId = uuid();
    await supabase.from('users').upsert({
      id: agentUserId, email: agent.email,
      password_hash: agentUserHash,
      first_name: agent.name.split(' ')[0], last_name: agent.name.split(' ')[1],
      role: 'agent', plan: 'enterprise', subscription_status: 'active', token_version: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'email' });

    await supabase.from('agents').upsert({
      id: uuid(), user_id: agentUserId, ...agent,
      current_tasks: Math.floor(Math.random() * 3),
      avg_handle_time_minutes: Math.floor(Math.random() * 6) + 5,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'email' });
  }
  console.log(`✅ ${agents.length} agents seeded (password: agent123!)`);

  // ── Sample tasks ───────────────────────────────────────────────────────────
  const tasks = [
    {
      title: 'Research top 5 competitors in HR tech space',
      description: 'Need a competitive analysis with pricing and key features for each',
      type: 'research', priority: 'normal', status: 'completed', handler: 'ai',
    },
    {
      title: 'Schedule vendor call with Manila office — next Tuesday 3pm',
      description: 'Vendor: Ramon Cruz, +63 917 555 0122. Any Tuesday after 2pm PHT works.',
      type: 'scheduling', priority: 'urgent', status: 'assigned', handler: 'human',
    },
    {
      title: 'Draft follow-up email to client from yesterday\'s pitch',
      description: 'Client is a startup founder, needs a warm but professional tone',
      type: 'writing', priority: 'normal', status: 'completed', handler: 'ai',
    },
    {
      title: 'Transcribe 10-minute board meeting audio',
      type: 'transcription', priority: 'low', status: 'completed', handler: 'ai',
    },
  ];

  for (const task of tasks) {
    const taskId = uuid();
    await supabase.from('tasks').insert({
      id: taskId, user_id: clientId, ...task,
      created_at: new Date(Date.now() - Math.random() * 86400000 * 3).toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: task.status === 'completed' ? new Date().toISOString() : null,
    });

    // Add a task result for completed tasks
    if (task.status === 'completed') {
      await supabase.from('task_results').insert({
        id: uuid(), task_id: taskId,
        output: `[Sample output for: ${task.title}] This is where the AI or agent\'s completed work would appear.`,
        confidence: task.handler === 'ai' ? Math.floor(Math.random() * 20) + 78 : null,
        handler: task.handler,
        created_at: new Date().toISOString(),
      });
    }

    // Add sample messages
    await supabase.from('messages').insert({
      id: uuid(), task_id: taskId,
      sender_id: null, sender_type: 'ai', sender_name: 'Panalo AI',
      body: `I'm working on your task "${task.title}" now. I'll have a result shortly.`,
      created_at: new Date().toISOString(),
    });
  }

  console.log(`✅ ${tasks.length} sample tasks seeded`);
  console.log('\n🎉 Seed complete! Test credentials:');
  console.log('   Admin:  admin@panalo.ai  / admin123!');
  console.log('   Client: sarah@buildco.com / client123!');
  console.log('   Agents: maria@panalo.ai  / agent123! (and others)');
}

seed().catch(console.error);
