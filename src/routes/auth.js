import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { body, validationResult } from 'express-validator';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase.js';
import { generateTokens, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { sendWelcomeEmail, sendPasswordResetEmail } from '../lib/email.js';
import { logger } from '../lib/logger.js';

const router = Router();

// ── POST /api/auth/register ──────────────────────────────────────────────────
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('first_name').notEmpty().trim(),
  body('last_name').notEmpty().trim(),
  body('company').optional().trim(),
  body('plan').optional().isIn(['starter','pro','enterprise']),
  body('signup_token').optional().isString().isLength({ min: 16, max: 64 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, password, first_name, last_name, company, plan = 'starter' } = req.body;

  // Check existing user
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .single();

  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const password_hash = await bcrypt.hash(password, 12);

  const { data: user, error } = await supabase
    .from('users')
    .insert({
      id: uuid(), email, password_hash, first_name, last_name,
      company: company || null,
      role:    'client',
      plan,
      task_count:    0,
      token_version: 0,
      created_at:    new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    logger.error('User registration failed', { email, error: error.message });
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }

  // Convert any existing leads (escalated or not) into real tasks on the new
  // user's dashboard. Matches by email AND optionally by signup_token if
  // provided (more specific). Non-blocking — registration succeeds either way.
  const convertedTasks = await convertLeadsToTasks(user, req.body.signup_token).catch(err => {
    logger.warn('Lead-to-task conversion failed', { userId: user.id, error: err.message });
    return [];
  });

  const tokens = generateTokens(user);

  // Send welcome email (non-blocking)
  sendWelcomeEmail(user).catch(err => logger.warn('Welcome email failed', { error: err.message }));

  logger.info('User registered', {
    userId: user.id, email, plan,
    convertedTasks: convertedTasks.length,
  });

  res.status(201).json({
    message: 'Account created successfully',
    user: sanitizeUser(user),
    converted_tasks: convertedTasks.length,
    ...tokens,
  });
}));

// ── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  body('expected_role').optional().isIn(['client','agent','admin']),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, password, expected_role } = req.body;

  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();

  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Reject login attempts on Google-only accounts that don't have a password set
  if (!user.password_hash) {
    return res.status(401).json({
      error: 'This account was created with Google. Please continue with Google.'
    });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    logger.warn('Failed login attempt', { email });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Role-mismatch guard: if the caller said which role they expected (e.g. the
  // Client/Agent tab they used, or the admin login page), reject mismatches
  // with a clear message instead of silently logging them in.
  if (expected_role && user.role !== expected_role) {
    const friendly = {
      client: 'This is not a client account. Use the correct sign-in option.',
      agent:  'This is not an agent account. Use the correct sign-in option.',
      admin:  'This account does not have admin access.'
    };
    logger.warn('Role mismatch on login', { email, userRole: user.role, expected_role });
    return res.status(403).json({ error: friendly[expected_role] || 'Wrong sign-in type for this account.' });
  }

  // Update last login
  await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

  const tokens = generateTokens(user);
  logger.info('User logged in', { userId: user.id, email, role: user.role });

  res.json({
    message: 'Login successful',
    user: sanitizeUser(user),
    ...tokens,
  });
}));

// ── POST /api/auth/google ────────────────────────────────────────────────────
// Frontend completes Supabase Google OAuth, then sends us the resulting
// Supabase access_token. We verify it with Supabase, then either find
// or create a matching user (always role='client') and issue OUR custom JWTs.
router.post('/google', [
  body('access_token').isString().notEmpty(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { access_token } = req.body;

  const supaAuth = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
  const { data: gData, error: gErr } = await supaAuth.auth.getUser(access_token);
  if (gErr || !gData?.user) {
    logger.warn('Google sign-in: invalid Supabase token', { error: gErr?.message });
    return res.status(401).json({ error: 'Invalid Google sign-in token' });
  }

  const supaUser = gData.user;
  const email = (supaUser.email || '').toLowerCase().trim();
  const googleId = supaUser.user_metadata?.provider_id || supaUser.user_metadata?.sub || supaUser.id;
  const fullName = supaUser.user_metadata?.full_name || supaUser.user_metadata?.name || '';
  const [first_name = '', ...rest] = fullName.split(' ');
  const last_name = rest.join(' ') || '';
  const avatar_url = supaUser.user_metadata?.avatar_url || supaUser.user_metadata?.picture || null;

  if (!email) {
    return res.status(400).json({ error: 'Google account has no email' });
  }

  let { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('google_id', googleId)
    .single();

  if (!user) {
    const { data: byEmail } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    user = byEmail || null;
  }

  if (!user) {
    // New user — always create as 'client' (no agent self-signup via Google)
    const { data: created, error: insErr } = await supabase
      .from('users')
      .insert({
        id: uuid(),
        email,
        password_hash: null,
        first_name: first_name || email.split('@')[0],
        last_name,
        google_id: googleId,
        avatar_url,
        role: 'client',
        plan: 'starter',
        task_count: 0,
        token_version: 0,
        auth_provider: 'google',
        created_at: new Date().toISOString(),
        last_login: new Date().toISOString(),
      })
      .select()
      .single();
    if (insErr) {
      logger.error('Google sign-up failed', { email, error: insErr.message });
      return res.status(500).json({ error: 'Could not create account' });
    }
    user = created;
    sendWelcomeEmail(user).catch(err => logger.warn('Welcome email failed', { error: err.message }));

    // Convert any pending leads matching this email into tasks
    convertLeadsToTasks(user).then(
      (converted) => logger.info('Google signup: converted leads', { userId: user.id, count: converted.length }),
      (err) => logger.warn('Google signup lead conversion failed', { userId: user.id, error: err.message }),
    );

    logger.info('User registered via Google', { userId: user.id, email });
  } else {
    // Block agents and admins from signing in via Google (which would create a
    // role='client' on first contact). Forces them to use email/password.
    if (user.role !== 'client') {
      logger.warn('Google sign-in blocked for non-client role', { email, role: user.role });
      return res.status(403).json({
        error: 'Google sign-in is only available for clients. Please sign in with email and password.'
      });
    }
    const updates = { last_login: new Date().toISOString() };
    if (!user.google_id) updates.google_id = googleId;
    if (!user.avatar_url && avatar_url) updates.avatar_url = avatar_url;
    const { data: updated } = await supabase
      .from('users')
      .update(updates)
      .eq('id', user.id)
      .select()
      .single();
    if (updated) user = updated;
    logger.info('User logged in via Google', { userId: user.id, email });
  }

  const tokens = generateTokens(user);
  res.json({
    message: 'Google sign-in successful',
    user: sanitizeUser(user),
    ...tokens,
  });
}));

// ── POST /api/auth/refresh ───────────────────────────────────────────────────
router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: 'Refresh token required' });

  let payload;
  try {
    payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  const { data: user } = await supabase
    .from('users').select('*').eq('id', payload.id).single();

  if (!user || user.token_version !== payload.version) {
    return res.status(401).json({ error: 'Token invalidated' });
  }

  const tokens = generateTokens(user);
  res.json(tokens);
}));

// ── POST /api/auth/logout ────────────────────────────────────────────────────
router.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  // Increment token_version to invalidate all existing refresh tokens
  await supabase.from('users')
    .update({ token_version: (req.user.version || 0) + 1 })
    .eq('id', req.user.id);

  logger.info('User logged out', { userId: req.user.id });
  res.json({ message: 'Logged out successfully' });
}));

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const { data: user } = await supabase
    .from('users').select('*').eq('id', req.user.id).single();

  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: sanitizeUser(user) });
}));

// ── POST /api/auth/forgot-password ──────────────────────────────────────────
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
], asyncHandler(async (req, res) => {
  const { email } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('email', email).single();

  // Always return success to prevent email enumeration
  res.json({ message: 'If that email exists, a reset link has been sent.' });

  if (!user) return;

  const token  = uuid();
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  await supabase.from('password_reset_tokens').insert({
    user_id: user.id, token, expires_at: expiry, used: false,
  });

  sendPasswordResetEmail(user, token).catch(err =>
    logger.warn('Password reset email failed', { error: err.message }));
}));

// ── POST /api/auth/reset-password ───────────────────────────────────────────
router.post('/reset-password', [
  body('token').notEmpty(),
  body('password').isLength({ min: 8 }),
], asyncHandler(async (req, res) => {
  const { token, password } = req.body;

  const { data: resetRecord } = await supabase
    .from('password_reset_tokens')
    .select('*, users(*)')
    .eq('token', token)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (!resetRecord) {
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }

  const password_hash = await bcrypt.hash(password, 12);

  await Promise.all([
    supabase.from('users').update({ password_hash, token_version: 1 }).eq('id', resetRecord.user_id),
    supabase.from('password_reset_tokens').update({ used: true }).eq('token', token),
  ]);

  res.json({ message: 'Password reset successfully' });
}));

/**
 * Convert any matching leads into real tasks on a newly registered user's dashboard.
 *
 * Match rules:
 *   1. If signupToken is provided, find that specific lead (most precise)
 *   2. Also find all OTHER leads matching the user's email AND status='escalated'
 *      AND not already converted
 *
 * For each matched lead:
 *   - Create a corresponding row in `tasks` (handler='human', status='review')
 *   - Update the lead row: status='converted', converted_user_id, converted_at
 *
 * Returns array of created task objects (or empty array on no-op / error).
 */
async function convertLeadsToTasks(user, signupToken) {
  if (!user || !user.id || !user.email) return [];

  // Build the query: signup_token match OR (email match AND escalated AND not converted)
  let leads = [];

  if (signupToken) {
    const { data: tokenLead } = await supabase
      .from('leads')
      .select('*')
      .eq('signup_token', signupToken)
      .is('converted_user_id', null)
      .maybeSingle();
    if (tokenLead) leads.push(tokenLead);
  }

  // Also pick up any other unconverted leads matching this email
  // (both 'escalated' and 'ai_completed' are convertible — different task statuses)
  const { data: emailLeads } = await supabase
    .from('leads')
    .select('*')
    .eq('email', user.email)
    .in('status', ['escalated', 'ai_completed'])
    .is('converted_user_id', null);

  if (Array.isArray(emailLeads)) {
    for (const l of emailLeads) {
      if (!leads.find(existing => existing.id === l.id)) leads.push(l);
    }
  }

  if (leads.length === 0) return [];

  const createdTasks = [];
  for (const lead of leads) {
    // Derive the task's status + handler from the lead's status:
    //   'escalated'    → task status='review',    handler='human'
    //   'ai_completed' → task status='completed', handler='ai'
    const isEscalated = lead.status === 'escalated';
    const taskStatus  = isEscalated ? 'review'   : 'completed';
    const taskHandler = isEscalated ? 'human'    : 'ai';

    const taskTitle = (lead.task || 'Submitted task').slice(0, 200);
    const { data: task, error: insErr } = await supabase
      .from('tasks')
      .insert({
        client_id:           user.id,
        title:               taskTitle,
        description:         lead.task,
        type:                'general',
        priority:            'normal',
        status:              taskStatus,
        handler:             taskHandler,
        ai_output:           lead.ai_output || null,
        ai_confidence:       lead.ai_confidence || null,
        lead_id:             lead.id,
        original_lead_email: lead.email,
        created_at:          lead.created_at || new Date().toISOString(),
      })
      .select()
      .single();

    if (insErr) {
      logger.error('Lead-to-task: insert task failed', { leadId: lead.id, error: insErr.message });
      continue;
    }

    // Mark the lead as converted
    await supabase
      .from('leads')
      .update({
        status: 'converted',
        converted_user_id: user.id,
        converted_at: new Date().toISOString(),
        signup_token: null,         // invalidate token (single use)
        signup_token_expires: null,
      })
      .eq('id', lead.id);

    createdTasks.push(task);
  }

  return createdTasks;
}

function sanitizeUser(user) {
  const { password_hash, token_version, ...safe } = user;
  return safe;
}

export default router;
