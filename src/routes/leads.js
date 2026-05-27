import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { supabase } from '../lib/supabase.js';
import { asyncHandler } from '../middleware/error.js';
import { sendLeadNotificationEmail } from '../lib/email.js';
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
    // Fail closed — if the verifier itself failed, treat as suspicious
    return { ok: false, reason: 'verifier_unreachable' };
  }
}

// ── POST /api/leads/submit ──────────────────────────────────────────────────
// Public endpoint — no auth required. Guests submit a task from the homepage.
router.post('/submit', leadsLimiter, [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('task').isString().trim().isLength({ min: 5, max: 2000 }).withMessage('Task must be 5–2000 characters'),
  body('website').optional().isString(),           // honeypot — must be empty
  body('turnstile_token').optional().isString(),
  body('source').optional().isString().isLength({ max: 60 }),
  body('page_url').optional().isString().isLength({ max: 500 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0]?.msg || 'Invalid input' });
  }

  const { email, task, website, turnstile_token, source, page_url } = req.body;

  // 1. Honeypot check — bots typically fill all visible fields
  if (website && website.trim().length > 0) {
    logger.warn('Lead rejected: honeypot triggered', { email, ip: req.ip });
    // Return 200 to not tip off the bot that we caught it
    return res.json({ ok: true });
  }

  // 2. Verify Cloudflare Turnstile
  const turnstile = await verifyTurnstile(turnstile_token, req.ip);
  if (!turnstile.ok) {
    logger.warn('Lead rejected: bot check failed', {
      email, ip: req.ip, reason: turnstile.reason,
    });
    return res.status(403).json({ error: 'Verification failed. Please refresh and try again.' });
  }

  // 3. Best-effort insert into leads table (don't block email on DB failure)
  const userAgent = (req.get('user-agent') || '').slice(0, 500);
  const insertPayload = {
    email,
    task,
    ip: req.ip,
    user_agent: userAgent,
    source: source || 'homepage_hero',
    page_url: page_url || null,
    status: 'new',
  };
  const { data: lead, error: dbErr } = await supabase
    .from('leads')
    .insert(insertPayload)
    .select()
    .single();

  if (dbErr) {
    logger.error('Lead DB insert failed (will still send email)', {
      email, error: dbErr.message,
    });
  }

  // 4. Send the team notification email (don't fail the request if email fails;
  //    the lead is already saved in the DB).
  try {
    await sendLeadNotificationEmail({
      leadEmail: email,
      task,
      ip: req.ip,
      userAgent,
      source: source || 'homepage_hero',
      pageUrl: page_url,
    });
    logger.info('Lead notification sent', { email, leadId: lead?.id });
  } catch (err) {
    logger.error('Lead email send failed', { email, error: err.message });
    // Still return success to the user — we have the lead in the DB
  }

  res.json({ ok: true, message: 'Thanks — we\'ll be in touch within 24 hours.' });
}));

export default router;
