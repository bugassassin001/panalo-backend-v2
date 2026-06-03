import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../lib/supabase.js';
import { asyncHandler } from '../middleware/error.js';
import { sendLeadNotificationEmail } from '../lib/email.js';
import { logger } from '../lib/logger.js';

const router = Router();

// Optional auth — populates req.user if token is valid; never rejects
function optionalAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return next();
  try {
    const payload = jwt.verify(match[1], process.env.JWT_SECRET);
    if (payload && payload.id) {
      req.user = { id: payload.id, email: payload.email, role: payload.role, version: payload.version };
    }
  } catch (_e) {}
  next();
}

// ── Strict rate limit — AI calls cost real money ────────────────────────────
// 3 previews per IP per 15 min. Tune as needed once you see real usage.
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You\'ve reached the AI preview limit. Please try again in 15 minutes.' },
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
      method: 'POST', body: form,
    });
    const data = await res.json();
    if (!data.success) {
      return { ok: false, reason: 'turnstile_failed', codes: data['error-codes'] };
    }
    return { ok: true };
  } catch (err) {
    logger.error('Turnstile verify errored', { error: err.message });
    return { ok: false, reason: 'verifier_unreachable' };
  }
}

// ── POST /api/ai/preview ────────────────────────────────────────────────────
// Public endpoint. Visitor submits a task → we save the lead → call Anthropic
// → return AI output + confidence + lead_id so the frontend can later escalate.
router.post('/preview', optionalAuth, aiLimiter, [
  body('email').isEmail().withMessage('Valid email required')
    .isLength({ max: 254 })
    .customSanitizer((v) => String(v || '').trim()),
  body('task').isString().trim().isLength({ min: 5, max: 2000 }).withMessage('Task must be 5–2000 characters'),
  body('website').optional().isString(),                  // honeypot
  body('turnstile_token').optional().isString(),
  body('source').optional().isString().isLength({ max: 60 }),
  body('page_url').optional().isString().isLength({ max: 500 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0]?.msg || 'Invalid input' });
  }

  const { email, task, website, turnstile_token, source, page_url } = req.body;

  // 1. Honeypot
  if (website && website.trim().length > 0) {
    logger.warn('AI preview rejected: honeypot triggered', { email, ip: req.ip });
    return res.json({ ok: true, fake: true });
  }

  // 2. Turnstile
  const turnstile = await verifyTurnstile(turnstile_token, req.ip);
  if (!turnstile.ok) {
    logger.warn('AI preview rejected: bot check failed', { email, ip: req.ip, reason: turnstile.reason });
    return res.status(403).json({ error: 'Verification failed. Please refresh and try again.' });
  }

  // 3. Pre-create the lead row with status='ai_attempted'. We get a lead_id
  //    back which the frontend will send if the user clicks "Request Human Review".
  const userAgent = (req.get('user-agent') || '').slice(0, 500);
  const leadInsert = {
    email, task,
    ip: req.ip,
    user_agent: userAgent,
    source: source || 'homepage_hero',
    page_url: page_url || null,
    status: 'ai_attempted',
  };
  if (req.user?.id) leadInsert.client_id = req.user.id;

  const { data: lead, error: insErr } = await supabase
    .from('leads')
    .insert(leadInsert)
    .select()
    .single();

  if (insErr) {
    logger.error('AI preview: lead insert failed', { email, error: insErr.message });
    return res.status(500).json({ error: 'Could not save your request. Please try again.' });
  }

  // 4. Call Anthropic
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error('ANTHROPIC_API_KEY not configured');
    return res.status(500).json({ error: 'AI is not configured yet. Please try the human team instead.' });
  }

  const anthropic = new Anthropic({ apiKey });
  const systemPrompt = `You are Panalo.ai's AI task execution engine. A user has submitted a task for you to complete.

Your job:
1. Attempt to complete the task to the best of your ability
2. Provide a concrete, actionable result (not just advice)
3. Be specific and useful — draft actual content, actual answers, actual outputs
4. At the END of your response, on a new line, output exactly: CONFIDENCE:[number] where number is 0-100 representing how completely you were able to fulfill this task

If you truly cannot complete the task (e.g., it requires real-world actions like making phone calls, accessing private systems, or sending actual emails), still provide as much help as possible (drafts, plans, information) and give a lower confidence score.

Keep responses focused and practical. Under 300 words unless the task requires more.`;

  let text = '';
  let confidence = 0;
  try {
    const message = await anthropic.messages.create({
      model: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: parseInt(process.env.AI_MAX_TOKENS) || 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Complete this task: ${task}` }],
    });

    const fullText = message.content
      ?.filter(b => b.type === 'text')
      ?.map(b => b.text)
      ?.join('\n') || '';

    const confMatch = fullText.match(/CONFIDENCE:(\d+)/);
    confidence = confMatch ? Math.min(100, Math.max(0, parseInt(confMatch[1], 10))) : 70;
    text = fullText.replace(/\n?CONFIDENCE:\d+\s*$/, '').trim();
  } catch (err) {
    logger.error('Anthropic call failed', { leadId: lead.id, error: err.message });
    // Save a marker that the AI failed but still return something useful
    await supabase.from('leads')
      .update({ ai_output: '(AI call failed)', ai_confidence: 0 })
      .eq('id', lead.id);
    return res.status(502).json({
      error: 'Our AI is temporarily unavailable. You can still request a human review.',
      lead_id: lead.id,
    });
  }

  // 5. Save AI output to the lead row for context if they later escalate
  await supabase.from('leads')
    .update({ ai_output: text, ai_confidence: confidence })
    .eq('id', lead.id)
    .then(() => {}, (e) => logger.warn('Failed to save AI output to lead', { error: e?.message }));

  // 6. Notify the team a new lead came in — but only for GUESTS.
  //    Existing users submitting via the homepage hero aren't new leads;
  //    they'll be visible to agents via the normal task/agent workflow.
  if (!req.user?.id) {
    sendLeadNotificationEmail({
      leadEmail: email, task,
      ip: req.ip, userAgent,
      source: source || 'homepage_hero',
      pageUrl: page_url,
      aiOutput: text,
      aiConfidence: confidence,
    }).catch(err => logger.warn('Lead notification email failed', { error: err.message }));
  }

  logger.info('AI preview generated', { leadId: lead.id, email, confidence });

  res.json({
    ok: true,
    lead_id: lead.id,
    text,
    confidence,
    user_signed_in: !!req.user?.id,
  });
}));

export default router;
