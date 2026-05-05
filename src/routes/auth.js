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
      auth_provider: 'email',
      created_at:    new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    logger.error('User registration failed', { email, error: error.message });
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }

  const tokens = generateTokens(user);

  // Send welcome email (non-blocking)
  sendWelcomeEmail(user).catch(err => logger.warn('Welcome email failed', { error: err.message }));

  logger.info('User registered', { userId: user.id, email, plan });

  res.status(201).json({
    message: 'Account created successfully',
    user: sanitizeUser(user),
    ...tokens,
  });
}));

// ── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, password } = req.body;

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

  // Update last login
  await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

  const tokens = generateTokens(user);
  logger.info('User logged in', { userId: user.id, email });

  res.json({
    message: 'Login successful',
    user: sanitizeUser(user),
    ...tokens,
  });
}));

// ── POST /api/auth/google ────────────────────────────────────────────────────
// Frontend completes Supabase Google OAuth, sends us the resulting Supabase
// access_token. We verify it with Supabase, then either find or create the
// matching user in OUR users table, and finally issue OUR custom JWTs.
router.post('/google', [
  body('access_token').isString().notEmpty(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { access_token } = req.body;

  // 1. Verify the Supabase token by asking Supabase who it belongs to
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

  // 2. Try to find an existing user by google_id, then by email
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

  // 3a. New user — create the account
  if (!user) {
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
    logger.info('User registered via Google', { userId: user.id, email });
  } else {
    // 3b. Existing user — link google_id if not already linked, update last login
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

  // 4. Issue OUR custom JWTs (same shape as /login and /register)
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

function sanitizeUser(user) {
  const { password_hash, token_version, ...safe } = user;
  return safe;
}

export default router;