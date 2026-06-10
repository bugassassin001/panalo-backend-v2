import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
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
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Valid email required')
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

  let { email, task, website, turnstile_token, source, page_url } = req.body;

  // If the user is authenticated, ALWAYS use the email from the DB (the source
  // of truth). This prevents bugs where the client sends a stale or normalized
  // email from localStorage and breaks downstream notifications.
  if (req.user?.id) {
    const { data: dbUser } = await supabase
      .from('users').select('email').eq('id', req.user.id).single();
    if (dbUser?.email) email = dbUser.email;
  }

  // Guests must still provide an email
  if (!email) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  // 1. Honeypot
  if (website && website.trim().length > 0) {
    logger.warn('AI preview rejected: honeypot triggered', { email, ip: req.ip });
    return res.json({ ok: true, fake: true });
  }

  // 2. Turnstile — only required for guests. Logged-in users have already
  //    cleared our auth wall, no need for bot verification on top of that.
  if (!req.user?.id) {
    const turnstile = await verifyTurnstile(turnstile_token, req.ip);
    if (!turnstile.ok) {
      logger.warn('AI preview rejected: bot check failed', { email, ip: req.ip, reason: turnstile.reason });
      return res.status(403).json({ error: 'Verification failed. Please refresh and try again.' });
    }
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

// ============================================================
// AI CONVERSATION — Continue chatting with the AI on a task
// ============================================================
// Endpoints:
//   GET  /api/ai/conversation/:taskId   → load full thread
//   POST /api/ai/conversation/:taskId   → send user message, get AI reply
//
// Guardrails:
//   • Only the task's owning client can use these endpoints
//   • Only allowed when task.handler='ai' AND status not in ('review','completed','done')
//   • Hard cap at MAX_AI_TURNS user messages per task (cost control)
//   • Conversation context capped at MAX_CONTEXT_MESSAGES (cost control)
// ============================================================

const MAX_AI_TURNS         = 10;   // user messages per task before forcing escalation
const MAX_CONTEXT_MESSAGES = 20;   // keep at most this many msgs in the context window
const MAX_CONVERSATION_TOKENS_OUT = 800;

// Per-user rate limit for AI conversation turns (separate from preview limiter)
const aiChatLimiter = rateLimit({
  windowMs: 60 * 1000,           // 1 minute window
  max:      8,                    // 8 turns/min per IP — keeps it human-paced
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You are sending messages too quickly. Please slow down.' },
});

// Helper: authorize the requester and load the task in one place.
async function loadTaskForAIConversation(taskId, user) {
  const { data: task, error } = await supabase
    .from('tasks').select('*').eq('id', taskId).single();
  if (error || !task) return { error: 'Task not found', status: 404 };
  if (user.role === 'client' && task.client_id !== user.id) {
    return { error: 'You do not own this task', status: 403 };
  }
  return { task };
}

// ── GET /api/ai/conversation/:taskId ────────────────────────────────────────
router.get('/conversation/:taskId', requireAuth, asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const loaded = await loadTaskForAIConversation(taskId, req.user);
  if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

  const { data: messages, error } = await supabase
    .from('task_ai_messages')
    .select('id, role, content, confidence, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('AI conversation GET failed', { taskId, error: error.message });
    return res.status(500).json({ error: 'Could not load AI conversation' });
  }

  /* If the table is empty for this task, surface the original AI output from
     the tasks row as the first assistant turn. Clients still see a coherent
     thread even before the first follow-up. */
  let thread = messages || [];
  if (thread.length === 0 && loaded.task.ai_output) {
    thread = [{
      id: 'seed-' + taskId,
      role: 'assistant',
      content: loaded.task.ai_output,
      confidence: loaded.task.ai_confidence ?? null,
      created_at: loaded.task.created_at,
      seeded: true,
    }];
  }

  const turnsUsed = (messages || []).filter(m => m.role === 'user').length;
  const handlerLocked =
    loaded.task.handler !== 'ai' ||
    ['review','completed','done'].includes(loaded.task.status);

  res.json({
    messages: thread,
    can_continue: !handlerLocked && turnsUsed < MAX_AI_TURNS,
    turns_used: turnsUsed,
    turns_remaining: Math.max(0, MAX_AI_TURNS - turnsUsed),
    handler_locked: handlerLocked,
  });
}));

// ── POST /api/ai/conversation/:taskId ───────────────────────────────────────
router.post('/conversation/:taskId',
  requireAuth,
  aiChatLimiter,
  [ body('message').isString().trim().isLength({ min: 1, max: 2000 })
      .withMessage('Message must be 1–2000 characters') ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0]?.msg || 'Invalid input' });
    }

    const { taskId } = req.params;
    const userMessage = req.body.message.trim();

    const loaded = await loadTaskForAIConversation(taskId, req.user);
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });
    const task = loaded.task;

    // Gate: only allow AI conversation when task is AI-handled and not escalated/completed
    if (task.handler !== 'ai') {
      return res.status(409).json({ error: 'This task is being handled by a human agent. Use the Chat tab to message them.' });
    }
    if (['review','completed','done'].includes(task.status)) {
      return res.status(409).json({ error: 'This task is no longer active for AI follow-ups.' });
    }

    // Load existing conversation + check turn budget
    const { data: existing, error: histErr } = await supabase
      .from('task_ai_messages')
      .select('role, content, created_at')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true });
    if (histErr) {
      logger.error('AI conversation history load failed', { taskId, error: histErr.message });
      return res.status(500).json({ error: 'Could not load conversation history' });
    }

    const turnsUsed = (existing || []).filter(m => m.role === 'user').length;
    if (turnsUsed >= MAX_AI_TURNS) {
      return res.status(429).json({
        error: `You've used all ${MAX_AI_TURNS} follow-ups for this task. Please request a human review for further help.`,
        turn_limit_reached: true,
      });
    }

    // Build the context window for Anthropic. Start with the original task as
    // the first user message, then include the seeded AI output (from the
    // tasks row) if we don't have a stored turn for it.
    const contextMessages = [];

    // First user turn = the original task description
    contextMessages.push({
      role: 'user',
      content: task.title + (task.description ? `\n\n${task.description}` : ''),
    });

    // First assistant turn = the original ai_output (only if there are no
    // stored assistant turns yet — otherwise the stored history is canonical)
    const hasStoredAssistantTurn = (existing || []).some(m => m.role === 'assistant');
    if (!hasStoredAssistantTurn && task.ai_output) {
      contextMessages.push({ role: 'assistant', content: task.ai_output });
    }

    // Append the stored back-and-forth (trim to MAX_CONTEXT_MESSAGES)
    const recentHistory = (existing || []).slice(-MAX_CONTEXT_MESSAGES);
    for (const m of recentHistory) {
      contextMessages.push({ role: m.role, content: m.content });
    }

    // Append the new user message
    contextMessages.push({ role: 'user', content: userMessage });

    // System prompt: ground the model in the original task + this is a
    // follow-up conversation, not a fresh task.
    const systemPrompt = [
      `You are Panalo.ai's task-completion assistant continuing a conversation with a client about their task.`,
      `The client has already received your initial response and is following up.`,
      `Provide concrete, actionable answers. If you need more information, ask one specific question.`,
      `Keep responses focused — 3–6 short paragraphs max. Use markdown for clarity.`,
      `End your response with a confidence score on a new line: [Confidence: NN%]`,
    ].join('\n');

    // Call Anthropic
    let aiText = '';
    let confidence = null;
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const completion = await anthropic.messages.create({
        model: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: MAX_CONVERSATION_TOKENS_OUT,
        system: systemPrompt,
        messages: contextMessages,
      });
      aiText = completion.content?.[0]?.text || '';
      const confMatch = aiText.match(/\[Confidence:\s*(\d{1,3})%?\]\s*$/i);
      if (confMatch) {
        confidence = Math.min(100, Math.max(0, parseInt(confMatch[1], 10)));
        aiText = aiText.replace(/\s*\[Confidence:\s*\d{1,3}%?\]\s*$/i, '').trim();
      }
    } catch (err) {
      logger.error('AI conversation Anthropic call failed', { taskId, error: err.message });
      return res.status(502).json({ error: 'The AI is unavailable right now. Please try again or request human review.' });
    }

    if (!aiText) {
      return res.status(502).json({ error: 'The AI returned an empty response. Please try again.' });
    }

    // Persist BOTH messages atomically (well, sequentially — Supabase doesn't
    // do transactions over the JS client, but these inserts almost never fail
    // independently).
    const now = new Date().toISOString();
    const userRow = {
      id: crypto.randomUUID(),
      task_id: taskId,
      role: 'user',
      content: userMessage,
      created_at: now,
    };
    const assistantRow = {
      id: crypto.randomUUID(),
      task_id: taskId,
      role: 'assistant',
      content: aiText,
      confidence,
      // tiny offset so it sorts after the user message
      created_at: new Date(Date.now() + 1).toISOString(),
    };

    const { error: insertErr } = await supabase
      .from('task_ai_messages')
      .insert([userRow, assistantRow]);
    if (insertErr) {
      logger.error('AI conversation insert failed', { taskId, error: insertErr.message });
      return res.status(500).json({ error: 'Could not save the conversation' });
    }

    // Best-effort: update the task's ai_output to the latest assistant
    // response so the original AI Output card stays fresh. Also bump ai_confidence.
    supabase.from('tasks')
      .update({
        ai_output: aiText,
        ai_confidence: confidence ?? task.ai_confidence,
        updated_at: now,
      })
      .eq('id', taskId)
      .then(() => {}, () => {});

    logger.info('AI conversation turn', {
      taskId, userId: req.user.id,
      turnsUsed: turnsUsed + 1, confidence,
    });

    res.json({
      user_message: userRow,
      assistant_message: assistantRow,
      confidence,
      turns_used: turnsUsed + 1,
      turns_remaining: Math.max(0, MAX_AI_TURNS - (turnsUsed + 1)),
    });
  })
);

export default router;
