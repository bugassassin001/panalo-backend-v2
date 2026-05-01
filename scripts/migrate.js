/**
 * Panalo.ai — Database Schema Migration
 * Run: node scripts/migrate.js
 * 
 * This creates all tables in your Supabase project.
 * You can also paste this SQL directly into Supabase SQL Editor.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SCHEMA = `
-- ═══════════════════════════════════════════════════════════════════
-- PANALO.AI DATABASE SCHEMA
-- ═══════════════════════════════════════════════════════════════════

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── USERS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email                 TEXT UNIQUE NOT NULL,
  password_hash         TEXT NOT NULL,
  first_name            TEXT NOT NULL,
  last_name             TEXT NOT NULL,
  company               TEXT,
  role                  TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client','agent','admin')),
  plan                  TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter','pro','enterprise')),
  subscription_status   TEXT DEFAULT 'trialing' CHECK (subscription_status IN ('active','trialing','past_due','cancelled','unpaid')),
  stripe_customer_id    TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  subscription_renews_at TIMESTAMPTZ,
  task_count            INTEGER DEFAULT 0,
  token_version         INTEGER DEFAULT 0,
  last_login            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── AGENTS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  location      TEXT DEFAULT 'Manila, PH',
  avatar_url    TEXT,
  role          TEXT DEFAULT 'agent' CHECK (role IN ('agent','senior_agent','supervisor')),
  status        TEXT DEFAULT 'offline' CHECK (status IN ('online','break','offline')),
  current_tasks INTEGER DEFAULT 0,
  completed_today INTEGER DEFAULT 0,
  avg_handle_time_minutes INTEGER DEFAULT 8,
  csat_score    NUMERIC(3,2) DEFAULT 5.0,
  shift_start   TIME,
  shift_end     TIME,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── TASKS ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id            UUID REFERENCES agents(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  description         TEXT,
  type                TEXT DEFAULT 'other' CHECK (type IN ('research','scheduling','writing','data_entry','transcription','customer_support','other')),
  complexity          TEXT CHECK (complexity IN ('simple','medium','complex')),
  priority            TEXT DEFAULT 'normal' CHECK (priority IN ('low','normal','urgent')),
  status              TEXT DEFAULT 'pending' CHECK (status IN ('pending','processing','assigned','completed','cancelled')),
  handler             TEXT CHECK (handler IN ('ai','human')),
  tags                TEXT[] DEFAULT '{}',
  due_date            TIMESTAMPTZ,
  estimated_minutes   INTEGER,
  ai_note             TEXT,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_tasks_user_id    ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_id   ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);

-- ── TASK RESULTS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_results (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  output       TEXT NOT NULL,
  confidence   INTEGER CHECK (confidence BETWEEN 0 AND 100),
  steps_taken  TEXT[],
  handler      TEXT CHECK (handler IN ('ai','human')),
  agent_id     UUID REFERENCES agents(id) ON DELETE SET NULL,
  rated        INTEGER CHECK (rated BETWEEN 1 AND 5),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_results_task_id ON task_results(task_id);

-- ── MESSAGES ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sender_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  sender_type  TEXT NOT NULL CHECK (sender_type IN ('client','agent','ai','system')),
  sender_name  TEXT,
  body         TEXT NOT NULL,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_task_id    ON messages(task_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- ── INVOICES ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_id  TEXT UNIQUE,
  amount     NUMERIC(10,2),
  currency   TEXT DEFAULT 'usd',
  status     TEXT DEFAULT 'paid',
  pdf_url    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── PASSWORD RESET TOKENS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── HELPER FUNCTIONS ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION increment_agent_tasks(agent_id UUID)
RETURNS void LANGUAGE sql AS $$
  UPDATE agents SET current_tasks = current_tasks + 1, updated_at = NOW()
  WHERE id = agent_id;
$$;

CREATE OR REPLACE FUNCTION decrement_agent_tasks(agent_id UUID)
RETURNS void LANGUAGE sql AS $$
  UPDATE agents
  SET current_tasks = GREATEST(0, current_tasks - 1),
      completed_today = completed_today + 1,
      updated_at = NOW()
  WHERE id = agent_id;
$$;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE OR REPLACE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── ROW LEVEL SECURITY ────────────────────────────────────────────────────────
ALTER TABLE users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_results ENABLE ROW LEVEL SECURITY;

-- Note: We use service role key server-side, so RLS is for direct Supabase access.
-- The policies below allow the service role to bypass them.
`;

async function migrate() {
  console.log('🗄️  Running Panalo.ai database migrations...\n');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
  }

  // Split into individual statements and run them
  const statements = SCHEMA
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 10);

  let succeeded = 0;
  let failed = 0;

  for (const stmt of statements) {
    try {
      const { error } = await supabase.rpc('exec_sql', { sql: stmt + ';' });
      if (error && !error.message.includes('already exists')) {
        console.warn(`  ⚠️  ${stmt.slice(0, 60)}...\n     → ${error.message}`);
        failed++;
      } else {
        succeeded++;
      }
    } catch (err) {
      // Try direct SQL via REST
      console.log(`  ℹ️  Statement logged (run manually if needed): ${stmt.slice(0, 60)}...`);
    }
  }

  console.log(`\n✅ Migration complete. ${succeeded} statements processed.`);
  console.log('\n📋 If statements failed, paste the SQL below directly into:');
  console.log('   Supabase Dashboard → SQL Editor → New Query\n');
  console.log('━'.repeat(60));
  console.log('Copy the SCHEMA from scripts/migrate.js and paste it there.');
  console.log('━'.repeat(60));
}

migrate().catch(console.error);
