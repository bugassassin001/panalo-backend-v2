import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase.js';
import { asyncHandler } from '../middleware/error.js';
import { sendLeadNotificationEmail, sendLeadEscalationEmail, sendVisitorEscalationConfirmation, sendVisitorAcceptConfirmation } from '../lib/email.js';
import { logger } from '../lib/logger.js';

const router = Router();

// ── Optional auth middleware ────────────────────────────────────────────────
// Unlike requireAuth, this NEVER rejects. If a valid Bearer token is present,
// it populates req.user. If absent/invalid, req.user is left undefined and
// the request proceeds as a guest.
function optionalAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return next();
  try {
    const payload = jwt.verify(match[1], process.env.JWT_SECRET);
    if (payload && payload.id) {
      req.user = { id: payload.id, email: payload.email, role: payload.role, version: payload.version };
    }
  } catch (_e) {
    // ignore — proceed as guest
  }
  next();
}

// ── Helper: create a task immediately from a logged-in user's lead ──────────
async function materializeTaskFromLead({ user, lead, status, handler }) {
  if (!user || !lead) return null;
  const taskTitle = (lead.task || 'Submitted task').slice(0, 200);
  const { data: task, error: insErr } = await supabase
    .from('tasks')
    .insert({
      client_id: user.id,
      title: taskTitle,
      description: lead.task,
      type: 'general',
      priority: 'normal',
      status,
      handler,
      ai_output: lead.ai_output || null,
      ai_confidence: lead.ai_confidence || null,
      lead_id: lead.id,
      original_lead_email: lead.email,
      created_at: lead.created_at || new Date().toISOString(),
    })
    .select()
    .single();

  if (insErr) {
    logger.error('Materialize task failed', { leadId: lead.id, error: insErr.message });
    return null;
  }

  // Mark the lead as converted (already attached to this user)
  await supabase.from('leads')
    .update({
      status: 'converted',
      converted_user_id: user.id,
      converted_at: new Date().toISOString(),
      signup_token: null,
      signup_token_expires: null,
    })
    .eq('id', lead.id);

  return task;
}

// ── Stricter rate limit just for leads (5 submissions per IP per hour) ──────
const leadsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions from this IP. Please try again later.' },
});

// Slightly more generous for /escalate since the visitor has already passed
// /submit (proven non-bot). 10/hour/IP.
const escalateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many escalations from this IP. Please try again later.' },
});

// ── Helper: verify Cloudflare Turnstile token ───────────────────────────────
async function verifyTurnstile(token, remoteip) {
  if (!process.env.TURNSTILE_SECRET_KEY) {
    logger.warn('TURNSTILE_SECRET_KEY not set — skipping bot verification');
    return { ok: true, skipped: true };
  }
  if (!token) return { ok: false, reason: 'missing_token' };

  try {
    const form = new URLSearchParams();
    form.append('secret', process.env.TURNSTILE_SECRET_KEY);
    form.append('response', token);
    if (remoteip) form.append('remoteip', remoteip);

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const data = await res.json();
    if (!data.success) {
      logger.warn('Turnstile verification failed', { errors: data['error-codes'] });
      return { ok: false, reason: 'turnstile_failed', codes: data['error-codes'] };
    }
    return { ok: true };
  } catch (err) {
    logger.error('Turnstile verify call errored', { error: err.message });
    return { ok: false, reason: 'verifier_unreachable' };
  }
}

// ── POST /api/leads/submit ──────────────────────────────────────────────────
// Public endpoint — no auth required. Visitor submits a task from the homepage.
// (This endpoint is still used for non-AI submissions; the new AI flow uses
//  /api/ai/preview which creates the lead row server-side.)
router.post('/submit', leadsLimiter, [
  body('email').isEmail().withMessage('Valid email required')
    .isLength({ max: 254 })
    .customSanitizer((v) => String(v || '').trim()),
  body('task').isString().trim().isLength({ min: 5, max: 2000 }).withMessage('Task must be 5–2000 characters'),
  body('website').optional().isString(),
  body('turnstile_token').optional().isString(),
  body('source').optional().isString().isLength({ max: 60 }),
  body('page_url').optional().isString().isLength({ max: 500 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0]?.msg || 'Invalid input' });
  }

  const { email, task, website, turnstile_token, source, page_url } = req.body;

  if (website && website.trim().length > 0) {
    logger.warn('Lead rejected: honeypot triggered', { email, ip: req.ip });
    return res.json({ ok: true });
  }

  const turnstile = await verifyTurnstile(turnstile_token, req.ip);
  if (!turnstile.ok) {
    logger.warn('Lead rejected: bot check failed', { email, ip: req.ip, reason: turnstile.reason });
    return res.status(403).json({ error: 'Verification failed. Please refresh and try again.' });
  }

  const userAgent = (req.get('user-agent') || '').slice(0, 500);
  const { data: lead, error: dbErr } = await supabase
    .from('leads')
    .insert({
      email, task,
      ip: req.ip,
      user_agent: userAgent,
      source: source || 'homepage_hero',
      page_url: page_url || null,
      status: 'new',
    })
    .select()
    .single();

  if (dbErr) {
    logger.error('Lead DB insert failed (will still send email)', { email, error: dbErr.message });
  }

  try {
    await sendLeadNotificationEmail({
      leadEmail: email, task,
      ip: req.ip, userAgent,
      source: source || 'homepage_hero',
      pageUrl: page_url,
    });
    logger.info('Lead notification sent', { email, leadId: lead?.id });
  } catch (err) {
    logger.error('Lead email send failed', { email, error: err.message });
  }

  res.json({ ok: true, message: 'Thanks — we\'ll be in touch within 24 hours.' });
}));

// ── POST /api/leads/escalate ────────────────────────────────────────────────
// Called when a visitor clicks "Request Human Review" after the AI preview.
// We update the existing lead row (created by /api/ai/preview), then send
// an escalation email to the team with the original task + AI output for context.
// If the requester is logged in, we ALSO materialize the task on their dashboard
// immediately (no signup needed).
router.post('/escalate', optionalAuth, escalateLimiter, [
  body('lead_id').isUUID().withMessage('lead_id required'),
  body('reason').optional().isString().trim().isLength({ max: 500 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0]?.msg || 'Invalid input' });
  }

  const { lead_id, reason } = req.body;

  // 1. Fetch the lead so we have task + email + AI output context
  const { data: lead, error: fetchErr } = await supabase
    .from('leads')
    .select('*')
    .eq('id', lead_id)
    .single();

  if (fetchErr || !lead) {
    logger.warn('Escalate: lead not found', { lead_id, error: fetchErr?.message });
    return res.status(404).json({ error: 'Lead not found' });
  }

  // 2. Generate a signup token (only useful for guests, but harmless to set always)
  const signupToken = randomUUID().replace(/-/g, '');
  const signupTokenExpires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const updates = {
    status: 'escalated',
    escalated_at: new Date().toISOString(),
    escalation_reason: reason || null,
    signup_token: signupToken,
    signup_token_expires: signupTokenExpires,
  };
  if (req.user?.id) updates.client_id = req.user.id;

  const { error: updateErr } = await supabase
    .from('leads')
    .update(updates)
    .eq('id', lead_id);

  if (updateErr) {
    logger.error('Escalate: status update failed', { lead_id, error: updateErr.message });
    // Continue — we still want to send the email
  }

  // 3. If the visitor is logged in, materialize the task on their dashboard now
  let materializedTask = null;
  if (req.user?.id) {
    const updatedLead = { ...lead, ...updates };
    materializedTask = await materializeTaskFromLead({
      user: req.user,
      lead: updatedLead,
      status: 'review',
      handler: 'human',
    });
  }

  // 3. Send escalation email to the team with full context
  try {
    await sendLeadEscalationEmail({
      leadEmail: lead.email,
      task: lead.task,
      aiOutput: lead.ai_output,
      aiConfidence: lead.ai_confidence,
      reason,
      leadId: lead.id,
      submittedAt: lead.created_at,
    });
    logger.info('Lead escalation email sent', { lead_id, email: lead.email });
  } catch (err) {
    logger.error('Escalation email send failed', { lead_id, error: err.message });
    // Lead is already marked escalated in DB — return success to user
  }

  // 4. Send confirmation email to the visitor — but ONLY for guests.
  //    Logged-in users will see the task on their dashboard immediately,
  //    so the "Track this task" email is redundant for them.
  if (!req.user?.id) {
    sendVisitorEscalationConfirmation({
      visitorEmail: lead.email,
      task: lead.task,
      leadId: lead.id,
      signupToken,
    }).then(
      () => logger.info('Visitor confirmation email sent', { lead_id, email: lead.email }),
      (err) => logger.warn('Visitor confirmation email failed', { lead_id, error: err.message }),
    );
  }

  res.json({
    ok: true,
    message: req.user?.id
      ? 'Escalated — view it on your dashboard.'
      : 'Escalated to our team — you\'ll hear back within 2 hours.',
    signup_token: req.user?.id ? null : signupToken,
    task_id: materializedTask?.id || null,
    user_signed_in: !!req.user?.id,
  });
}));

// ── POST /api/leads/accept ──────────────────────────────────────────────────
// Called when a visitor clicks "Accept Result" after the AI preview.
// Marks the lead as ai_completed. For guests, generates a signup token + sends
// a confirmation email so they can save the result to their account later.
// For logged-in users, materializes a task with status='completed' immediately.
router.post('/accept', optionalAuth, escalateLimiter, [
  body('lead_id').isUUID().withMessage('lead_id required'),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0]?.msg || 'Invalid input' });
  }

  const { lead_id } = req.body;

  const { data: lead, error: fetchErr } = await supabase
    .from('leads')
    .select('*')
    .eq('id', lead_id)
    .single();

  if (fetchErr || !lead) {
    logger.warn('Accept: lead not found', { lead_id, error: fetchErr?.message });
    return res.status(404).json({ error: 'Lead not found' });
  }

  const signupToken = randomUUID().replace(/-/g, '');
  const signupTokenExpires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const updates = {
    status: 'ai_completed',
    signup_token: signupToken,
    signup_token_expires: signupTokenExpires,
  };
  if (req.user?.id) updates.client_id = req.user.id;

  const { error: updateErr } = await supabase
    .from('leads')
    .update(updates)
    .eq('id', lead_id);

  if (updateErr) {
    logger.error('Accept: status update failed', { lead_id, error: updateErr.message });
    // continue — non-fatal
  }

  // If logged in, materialize the task as 'completed' immediately
  let materializedTask = null;
  if (req.user?.id) {
    const updatedLead = { ...lead, ...updates };
    materializedTask = await materializeTaskFromLead({
      user: req.user,
      lead: updatedLead,
      status: 'completed',
      handler: 'ai',
    });
  }

  // Send "Save this to your dashboard" email — only for guests
  if (!req.user?.id) {
    sendVisitorAcceptConfirmation({
      visitorEmail: lead.email,
      task: lead.task,
      aiOutput: lead.ai_output,
      aiConfidence: lead.ai_confidence,
      leadId: lead.id,
      signupToken,
    }).then(
      () => logger.info('Visitor accept confirmation email sent', { lead_id, email: lead.email }),
      (err) => logger.warn('Visitor accept confirmation email failed', { lead_id, error: err.message }),
    );
  }

  res.json({
    ok: true,
    message: req.user?.id
      ? 'Saved to your dashboard.'
      : 'Result saved. Check your email — create an account to save it permanently.',
    signup_token: req.user?.id ? null : signupToken,
    task_id: materializedTask?.id || null,
    user_signed_in: !!req.user?.id,
  });
}));

// ── GET /api/leads/by-token/:token ──────────────────────────────────────────
// Used by the signup page when the visitor arrives via the "Track this task"
// email link. Returns the email associated with the token so the form can
// pre-fill it. The token is single-use and time-limited.
router.get('/by-token/:token', asyncHandler(async (req, res) => {
  const { token } = req.params;
  if (!token || token.length < 16) {
    return res.status(400).json({ error: 'Invalid token' });
  }

  const { data: lead, error } = await supabase
    .from('leads')
    .select('email, signup_token_expires, converted_user_id')
    .eq('signup_token', token)
    .single();

  if (error || !lead) {
    return res.status(404).json({ error: 'Token not found or expired' });
  }
  if (lead.converted_user_id) {
    return res.status(410).json({ error: 'This task has already been linked to an account. Please sign in.' });
  }
  if (lead.signup_token_expires && new Date(lead.signup_token_expires) < new Date()) {
    return res.status(410).json({ error: 'This sign-up link has expired. Please sign up normally with your email.' });
  }

  res.json({ email: lead.email });
}));

export default router;
