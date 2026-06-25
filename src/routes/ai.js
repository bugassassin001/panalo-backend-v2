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

const MAX_AI_TURNS         = 15;   // human messages (client+agent combined) per task before forcing escalation
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
// Access rules for the AI conversation:
//   • Client owns the task → allowed (the original behavior)
//   • Agent is assigned to the task → allowed (so they can read AND chat)
//   • Admin → allowed (oversight + support)
async function loadTaskForAIConversation(taskId, user) {
  const { data: task, error } = await supabase
    .from('tasks').select('*').eq('id', taskId).single();
  if (error || !task) return { error: 'Task not found', status: 404 };

  if (user.role === 'client' && task.client_id !== user.id) {
    return { error: 'You do not own this task', status: 403 };
  }
  if (user.role === 'agent' && task.agent_id !== user.id) {
    return { error: 'This task is not assigned to you', status: 403 };
  }
  // Admins can access any task — no extra check

  return { task };
}

/* Map an authenticated user to the role label we store with their AI-thread
   messages. The DB column accepts 'client' | 'agent' | 'assistant'. Admins
   posting into a task get tagged as 'agent' for display purposes since the
   client sees them as a human helper, not a separate role. */
function senderRoleForUser(user) {
  if (user.role === 'agent' || user.role === 'admin') return 'agent';
  return 'client';
}

// ── GET /api/ai/conversation/:taskId ────────────────────────────────────────
router.get('/conversation/:taskId', requireAuth, asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const loaded = await loadTaskForAIConversation(taskId, req.user);
  if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

  const { data: messages, error } = await supabase
    .from('task_ai_messages')
    .select('id, role, content, confidence, sender_user_id, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('AI conversation GET failed', { taskId, error: error.message });
    return res.status(500).json({ error: 'Could not load AI conversation' });
  }

  /* Normalize the legacy 'user' role to 'client' for any old rows that haven't
     been migrated. New rows are written as 'client' | 'agent' | 'assistant'. */
  const normalized = (messages || []).map(m => ({
    ...m,
    role: m.role === 'user' ? 'client' : m.role,
  }));

  /* Always prepend two synthetic "seed" messages built from the tasks row:
       1. The original task description as the first client message
       2. The original AI output as the first assistant message
     These are NOT stored — they're computed every time so they survive any
     amount of follow-up activity. The agent and client always see the full
     conversation history regardless of how many turns have been taken. */
  const seedMessages = [];
  if (loaded.task.title || loaded.task.description) {
    /* Collapse parts: avoid duplicates when title === description (a common
       outcome when the client only filled the title in the new-task form,
       or when the form auto-mirrors title into description). Also trims
       whitespace-only strings out of the join. */
    const parts = [loaded.task.title, loaded.task.description]
      .map(s => (s || '').trim())
      .filter(Boolean);
    const uniqueParts = [...new Set(parts)]; // de-dupe identical strings
    const taskContent = uniqueParts.join('\n\n');
    if (taskContent) {
      seedMessages.push({
        id: 'seed-task-' + taskId,
        role: 'client',
        content: taskContent,
        confidence: null,
        sender_user_id: loaded.task.client_id,
        created_at: loaded.task.created_at,
        seeded: true,
      });
    }
  }
  /* AI seed bubble — the "original AI answer". Try multiple sources because
     historically tasks.ai_output got overwritten on every follow-up (now
     fixed), and some tasks may have NULL ai_output if the original AI call
     failed or the field was cleared. Order of preference:
       1. tasks.ai_output if present (the canonical original answer)
       2. The earliest stored assistant message in task_ai_messages as fallback
     If we use the fallback, we mark that stored message as "absorbed" so it
     doesn't render TWICE (once as seed, once as regular bubble). */
  let aiSeedContent     = loaded.task.ai_output || null;
  let aiSeedConfidence  = loaded.task.ai_confidence ?? null;
  let absorbedStoredId  = null;

  if (!aiSeedContent) {
    const firstAssistant = normalized.find(m => m.role === 'assistant');
    if (firstAssistant) {
      aiSeedContent    = firstAssistant.content;
      aiSeedConfidence = firstAssistant.confidence ?? null;
      absorbedStoredId = firstAssistant.id;
    }
  }

  if (aiSeedContent) {
    seedMessages.push({
      id: 'seed-ai-' + taskId,
      role: 'assistant',
      content: aiSeedContent,
      confidence: aiSeedConfidence,
      sender_user_id: null,
      /* +1ms after the task created_at so it sorts right after the client task seed */
      created_at: loaded.task.created_at
        ? new Date(new Date(loaded.task.created_at).getTime() + 1).toISOString()
        : null,
      seeded: true,
    });
  }

  /* Drop the absorbed message from the regular stream to avoid duplication.
     (Only applies when we fell back to a stored message for the seed.) */
  const remainingStored = absorbedStoredId
    ? normalized.filter(m => m.id !== absorbedStoredId)
    : normalized;

  const thread = [...seedMessages, ...remainingStored];

  /* Turns used = combined count of human-authored messages (client + agent).
     Both roles contribute against the same 15-message cap so cost is bounded. */
  const turnsUsed = normalized.filter(m => m.role === 'client' || m.role === 'agent').length;

  /* Lock the AI thread only when the task is fully finished. Earlier we also
     locked when status='review' (escalation) — but now agents can use the
     thread too, so review/active are both allowed. */
  const handlerLocked = ['completed','done'].includes(loaded.task.status);

  res.json({
    messages: thread,
    can_continue: !handlerLocked && turnsUsed < MAX_AI_TURNS,
    turns_used: turnsUsed,
    turns_remaining: Math.max(0, MAX_AI_TURNS - turnsUsed),
    handler_locked: handlerLocked,
    /* Tell the frontend which role the current user has so it can label its
       own messages distinctly from the other party's. */
    viewer_role: senderRoleForUser(req.user),
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
    const senderRole = senderRoleForUser(req.user);

    /* Gate: lock only when the task is completely done. Earlier we also locked
       when status='review' (escalation) — but with shared client+agent chat,
       agents using the thread on assigned tasks is the whole point. */
    if (['completed','done'].includes(task.status)) {
      return res.status(409).json({ error: 'This task is completed. The AI thread is read-only.' });
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

    /* Count both client AND agent messages against the same cap. Treat the
       legacy 'user' role as 'client' for back-compat with un-migrated rows. */
    const turnsUsed = (existing || []).filter(m => {
      const r = m.role === 'user' ? 'client' : m.role;
      return r === 'client' || r === 'agent';
    }).length;

    if (turnsUsed >= MAX_AI_TURNS) {
      return res.status(429).json({
        error: `This task has reached the ${MAX_AI_TURNS}-message limit. Please continue in the Chat tab or mark the task complete.`,
        turn_limit_reached: true,
      });
    }

    // Build the context window for Anthropic. ALWAYS start with the original
    // task as the first user message AND the original AI output as the first
    // assistant message — regardless of how many follow-ups exist. This keeps
    // the AI grounded in the original ask and its initial detailed answer.
    const contextMessages = [];

    // Seed 1: the original task description as the first user turn.
    // De-duplicate title vs description (common when the new-task form
    // mirrors title into description) so the AI doesn't see the same text twice.
    const seedParts = [task.title, task.description]
      .map(s => (s || '').trim())
      .filter(Boolean);
    const seedContent = [...new Set(seedParts)].join('\n\n');
    if (seedContent) {
      contextMessages.push({ role: 'user', content: seedContent });
    }

    // Seed 2: the original ai_output as the first assistant turn (always)
    if (task.ai_output) {
      contextMessages.push({ role: 'assistant', content: task.ai_output });
    }

    /* Append the stored back-and-forth (trim to MAX_CONTEXT_MESSAGES).
       Translate our domain roles to Anthropic's API roles:
       - 'client' or 'agent' → 'user' (both are "the human in the chat")
       - 'assistant' → 'assistant'
       Prefix human messages with the sender label so the model can address
       the right person when relevant. */
    const recentHistory = (existing || []).slice(-MAX_CONTEXT_MESSAGES);
    for (const m of recentHistory) {
      const domainRole = m.role === 'user' ? 'client' : m.role;
      if (domainRole === 'assistant') {
        contextMessages.push({ role: 'assistant', content: m.content });
      } else {
        const label = domainRole === 'agent' ? '[Agent]' : '[Client]';
        contextMessages.push({ role: 'user', content: `${label} ${m.content}` });
      }
    }

    /* Append the new human message — labelled so the AI knows whether it's
       responding to the client or the agent. */
    const senderLabel = senderRole === 'agent' ? '[Agent]' : '[Client]';
    contextMessages.push({
      role: 'user',
      content: `${senderLabel} ${userMessage}`,
    });

    /* System prompt: AI knows it's now in a three-way conversation. Important
       that it addresses whoever asked the latest question; otherwise responses
       feel disconnected when client and agent both contribute. */
    const systemPrompt = [
      `You are Panalo.ai's task-completion assistant. This conversation now includes BOTH the client (who submitted the task) and the assigned human agent (a Panalo team member helping the client).`,
      `Messages are labelled [Client] or [Agent] so you know who's speaking.`,
      `Address whoever asked the most recent question. When relevant, name them explicitly ("To answer your question, agent…") so everyone follows along.`,
      `If the agent is verifying or correcting earlier information, defer to them — they have context you may not.`,
      `Provide concrete, actionable answers. If you need more information, ask one specific question of the relevant party.`,
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

    /* Persist BOTH messages atomically (sequentially in practice).
       The new human message uses the actual sender role ('client' or 'agent')
       so the UI can label it correctly to all viewers. */
    const now = new Date().toISOString();
    const userRow = {
      id: crypto.randomUUID(),
      task_id: taskId,
      role: senderRole,                  // 'client' | 'agent'
      content: userMessage,
      sender_user_id: req.user.id,
      created_at: now,
    };
    const assistantRow = {
      id: crypto.randomUUID(),
      task_id: taskId,
      role: 'assistant',
      content: aiText,
      confidence,
      sender_user_id: null,
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

    /* Update only updated_at on the parent task. We intentionally do NOT
       overwrite tasks.ai_output anymore — that field holds the ORIGINAL AI
       response from task creation and must stay intact. The follow-up replies
       live in task_ai_messages where they belong. Overwriting ai_output here
       used to clobber the original detailed answer with the latest follow-up,
       which made the conversation history confusing and lost important context. */
    supabase.from('tasks')
      .update({ updated_at: now })
      .eq('id', taskId)
      .then(() => {}, () => {});

    logger.info('AI conversation turn', {
      taskId, userId: req.user.id, senderRole,
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