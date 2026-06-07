/**
 * Admin user management — endpoints for inviting new agents and admins.
 * Mount in src/index.js with: app.use('/api/admin', adminUsersRoutes);
 *
 * If you already have a src/routes/admin.js, mount this AT a different path
 * (e.g. '/api/admin/users') OR merge these handlers into the existing file.
 */
import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { sendAgentInviteEmail } from '../lib/email.js';
import { logger } from '../lib/logger.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));


// ── POST /api/admin/users ───────────────────────────────────────────────────
// Create a new agent or admin user. Admin-only.
// Generates an invite token, saves a placeholder user with no password,
// emails the invitee a "Set your password" link.
router.post('/users', [
    body('email').isEmail()
      .customSanitizer((v) => String(v || '').trim().toLowerCase()),
    body('first_name').notEmpty().trim().isLength({ max: 80 }),
    body('last_name').notEmpty().trim().isLength({ max: 80 }),
    body('role').isIn(['agent', 'admin']),
    body('confirm_admin').optional().isBoolean(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0]?.msg || 'Invalid input' });
    }

    const { email, first_name, last_name, role, confirm_admin } = req.body;

    // Extra safety: creating an admin requires explicit confirmation flag
    if (role === 'admin' && !confirm_admin) {
      return res.status(400).json({
        error: 'Creating an admin requires confirmation. Set confirm_admin=true to proceed.'
      });
    }

    // Check if a user already exists for this email
    const { data: existing } = await supabase
      .from('users')
      .select('id, role, email_verified, password_hash')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        error: `A user with this email already exists (role: ${existing.role}). To change roles, update directly in Supabase.`
      });
    }

    // Create the user row — no password yet, email NOT verified
    const userId = uuid();
    const { data: user, error: insErr } = await supabase
      .from('users')
      .insert({
        id: userId,
        email,
        password_hash: null,
        first_name,
        last_name,
        role,
        plan: 'starter',
        task_count: 0,
        token_version: 0,
        auth_provider: 'email',
        email_verified: false,
        invited_by: req.user.id,
        invited_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insErr) {
      logger.error('Admin invite: user insert failed', { email, role, error: insErr.message });
      return res.status(500).json({ error: 'Could not create the account. Please try again.' });
    }

    // Generate an invite/set-password token (reusing the password_reset_tokens table)
    const token  = uuid();
    const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
    await supabase.from('password_reset_tokens').insert({
      user_id: userId, token, expires_at: expiry, used: false,
    });

    // Audit log — admin creating admins is worth tracing
    if (role === 'admin') {
      logger.warn('ADMIN_CREATED', {
        new_admin_id: userId, new_admin_email: email,
        invited_by_id: req.user.id, invited_by_email: req.user.email,
      });
      // Best-effort notification to other admins (so you can spot rogue ones)
      try {
        const { data: otherAdmins } = await supabase
          .from('users').select('email')
          .eq('role', 'admin')
          .neq('id', req.user.id)
          .neq('id', userId);
        if (otherAdmins && otherAdmins.length) {
          await sendAgentInviteEmail({
            inviteeEmail: otherAdmins.map(a => a.email).join(','),
            inviteeName: 'Admin team',
            inviterName: req.user.email,
            role: 'notification_only',
            token: null,
            notificationOf: { email, first_name, last_name },
          }).catch(() => {});
        }
      } catch (_) { /* ignore */ }
    }

    // Send the invite email
    try {
      await sendAgentInviteEmail({
        inviteeEmail: email,
        inviteeName:  first_name,
        inviterName:  req.user.email,
        role,
        token,
      });
      logger.info('Invite email sent', { email, role });
    } catch (err) {
      logger.error('Invite email send failed', { email, error: err.message });
      // The user row is created and the token is saved — invite can be resent.
    }

    res.status(201).json({
      ok: true,
      message: `Invitation sent to ${email}. They have 7 days to set their password.`,
      user: { id: user.id, email: user.email, role: user.role },
    });
  }),
);

// ── POST /api/admin/users/:id/resend-invite ─────────────────────────────────
// If an invite email was lost, regenerate a fresh token and re-send. Admin-only.
router.post('/users/:id/resend-invite',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, first_name, role, password_hash, email_verified')
      .eq('id', id)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });
    if (user.password_hash) {
      return res.status(400).json({
        error: 'This account already has a password. Use the password-reset flow instead.'
      });
    }

    // Invalidate any pending tokens for this user, then create a fresh one
    await supabase.from('password_reset_tokens').update({ used: true }).eq('user_id', id).eq('used', false);
    const token  = uuid();
    const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('password_reset_tokens').insert({
      user_id: id, token, expires_at: expiry, used: false,
    });

    try {
      await sendAgentInviteEmail({
        inviteeEmail: user.email,
        inviteeName:  user.first_name,
        inviterName:  req.user.email,
        role:         user.role,
        token,
        isResend: true,
      });
    } catch (err) {
      logger.error('Resend invite failed', { id, error: err.message });
      return res.status(500).json({ error: 'Could not resend invite email.' });
    }

    res.json({ ok: true, message: 'Invite re-sent.' });
  }),
);

// ── GET /api/admin/users ───────────────────────────────────────────────────
// List all team-member accounts (agent + admin) for the admin dashboard.
router.get('/users',
  asyncHandler(async (req, res) => {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, email, first_name, last_name, role, email_verified, password_hash, invited_by, invited_at, last_login, created_at')
      .in('role', ['agent', 'admin'])
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Admin list users failed', { error: error.message });
      return res.status(500).json({ error: 'Could not load team members.' });
    }

    // Annotate each row with status flags the UI can use
    const annotated = (users || []).map(u => ({
      id: u.id,
      email: u.email,
      first_name: u.first_name,
      last_name: u.last_name,
      role: u.role,
      status: !u.password_hash    ? 'invite_pending'
            : !u.email_verified   ? 'unverified'
            : 'active',
      invited_at: u.invited_at,
      last_login: u.last_login,
      created_at: u.created_at,
    }));

    res.json({ users: annotated });
  }),
);

export default router;
