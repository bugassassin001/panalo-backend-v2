import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { asyncHandler } from '../middleware/error.js';
import { sendLeadNotificationEmail, sendLeadEscalationEmail, sendVisitorEscalationConfirmation } from '../lib/email.js';
import { logger } from '../lib/logger.js';

const router = Router();

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
router.post('/escalate', escalateLimiter, [
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

  // 2. Generate a signup token so the "Track your task" link in the email
  //    can identify the lead even before the visitor signs up.
  //    Token is a single-use, time-limited random string.
  const signupToken = randomUUID().replace(/-/g, '');
  const signupTokenExpires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(); // 14 days

  const { error: updateErr } = await supabase
    .from('leads')
    .update({
      status: 'escalated',
      escalated_at: new Date().toISOString(),
      escalation_reason: reason || null,
      signup_token: signupToken,
      signup_token_expires: signupTokenExpires,
    })
    .eq('id', lead_id);

  if (updateErr) {
    logger.error('Escalate: status update failed', { lead_id, error: updateErr.message });
    // Continue anyway — we still want to send the email
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

  // 4. Send confirmation email to the visitor (non-blocking, best-effort).
  //    Include the signup token so they can click "Track this task" and
  //    have their email pre-filled at signup.
  sendVisitorEscalationConfirmation({
    visitorEmail: lead.email,
    task: lead.task,
    leadId: lead.id,
    signupToken,
  }).then(
    () => logger.info('Visitor confirmation email sent', { lead_id, email: lead.email }),
    (err) => logger.warn('Visitor confirmation email failed', { lead_id, error: err.message }),
  );

  res.json({
    ok: true,
    message: 'Escalated to our team — you\'ll hear back within 2 hours.',
    signup_token: signupToken,   // frontend uses this to build the "Track your task" link
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
