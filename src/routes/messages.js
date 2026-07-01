import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { v4 as uuid } from 'uuid';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { logger } from '../lib/logger.js';

const router = Router();
router.use(requireAuth);

/* ── File attachment constants ────────────────────────────────────
   Chat files are stored in the shared `task-notes` Supabase Storage bucket
   under {taskId}/chat/{uuid}.ext so we reuse the same bucket + auth story
   as the Notes feature. */
const CHAT_FILES_BUCKET             = 'task-notes';
const CHAT_FILES_PATH_PREFIX        = 'chat';
const CHAT_MAX_FILES_PER_MESSAGE    = 3;                        // enough for a few screenshots
const CHAT_MAX_FILE_SIZE_BYTES      = 10 * 1024 * 1024;         // 10 MB per file
const CHAT_SIGNED_UPLOAD_TTL_SEC    = 60 * 5;                   // 5 min to actually upload
const CHAT_SIGNED_READ_TTL_SEC      = 60 * 60 * 24;             // 24h — refreshed on each GET

/* Allowed MIME prefixes — matches Notes so users have a consistent experience */
const CHAT_ALLOWED_MIME_PREFIXES = [
  'image/',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument',
  'application/vnd.ms-',
  'application/msword',
  'text/',
  'application/zip',
  'application/x-zip-compressed',
  'application/json',
];
const CHAT_BLOCKED_EXTENSIONS = [
  '.exe', '.bat', '.cmd', '.com', '.sh', '.app', '.dmg',
  '.jar', '.msi', '.scr', '.vbs', '.ps1', '.apk', '.deb', '.rpm',
];

/* Refresh signed read URLs for the JSONB files column. Bucket is private
   so we need short-lived signed URLs each time we return messages. */
async function refreshFileUrls(files) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const paths = files.map(f => f.storage_path).filter(Boolean);
  if (paths.length === 0) return files;
  const { data, error } = await supabase.storage
    .from(CHAT_FILES_BUCKET)
    .createSignedUrls(paths, CHAT_SIGNED_READ_TTL_SEC);
  if (error) {
    logger.warn('Chat refreshFileUrls failed', { error: error.message });
    return files;
  }
  return files.map((f, i) => ({ ...f, url: data[i]?.signedUrl || f.url }));
}

// Helper: load a task + the requesting user's display name in one place.
// Returns { task, senderName } or { error, status }.
async function authorizeAndLoad(taskId, user) {
  // Pull the task with both client and agent joined so we can also notify them.
  // Supabase needs the explicit FK name because there are two relationships
  // between tasks and users (client_id and agent_id).
  const { data: task, error: taskErr } = await supabase
    .from('tasks')
    .select(
      '*, ' +
      'client:users!tasks_client_id_fkey(id, first_name, last_name, email), ' +
      'agent:users!tasks_agent_id_fkey(id, first_name, last_name, email)'
    )
    .eq('id', taskId)
    .single();

  if (taskErr || !task) return { error: 'Task not found', status: 404 };

  // Authz — agents see tasks assigned to them, clients see their own, admins see all
  if (user.role === 'client' && task.client_id !== user.id) {
    return { error: 'Access denied', status: 403 };
  }
  if (user.role === 'agent' && task.agent_id !== user.id) {
    return { error: 'Access denied', status: 403 };
  }

  // Look up the requester's display name (not on JWT, must hit DB)
  const { data: me } = await supabase
    .from('users')
    .select('first_name, last_name, email')
    .eq('id', user.id)
    .single();
  const senderName = me
    ? (`${me.first_name || ''} ${me.last_name || ''}`.trim() || me.email)
    : user.email;

  return { task, senderName };
}

// ── GET /api/messages/:taskId ────────────────────────────────────────────────
// Returns all messages for a task, in chronological order.
// Also marks all messages from the OTHER party as read by the current user.
router.get('/:taskId', asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const auth = await authorizeAndLoad(taskId, req.user);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { data: messages, error } = await supabase
    .from('messages')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('GET messages failed', { taskId, error: error.message });
    return res.status(500).json({ error: 'Could not load messages' });
  }

  // Mark "the other side's" messages as read by me. Fire-and-forget.
  const nowIso = new Date().toISOString();
  if (req.user.role === 'client') {
    supabase.from('messages')
      .update({ read_by_client_at: nowIso })
      .eq('task_id', taskId)
      .neq('sender_type', 'client')
      .is('read_by_client_at', null)
      .then(() => {}, () => {});
  } else if (req.user.role === 'agent' || req.user.role === 'admin') {
    supabase.from('messages')
      .update({ read_by_agent_at: nowIso })
      .eq('task_id', taskId)
      .eq('sender_type', 'client')
      .is('read_by_agent_at', null)
      .then(() => {}, () => {});
  }

  /* Refresh signed URLs for any files attached to these messages.
     Done in parallel — fast even for a chat with many attachments. */
  const messagesWithFreshUrls = await Promise.all((messages || []).map(async m => ({
    ...m,
    files: await refreshFileUrls(m.files),
  })));

  res.json({ messages: messagesWithFreshUrls });
}));

// ── POST /api/messages/:taskId ───────────────────────────────────────────────
router.post('/:taskId', [
  /* body is now OPTIONAL when files are attached — enforced in the handler
     because express-validator can't easily express "one of these two". */
  body('body').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0]?.msg || 'Invalid input' });
  }

  const { taskId } = req.params;
  const messageBody = (req.body?.body || '').trim();

  /* Optional file attachments — each must reference an already-uploaded
     object in Storage (via /api/messages/:taskId/upload-url). */
  const rawFiles = Array.isArray(req.body?.files) ? req.body.files : [];
  if (rawFiles.length > CHAT_MAX_FILES_PER_MESSAGE) {
    return res.status(400).json({
      error: `Max ${CHAT_MAX_FILES_PER_MESSAGE} files per message.`,
    });
  }
  const attachedFiles = rawFiles.map(f => ({
    name: String(f.name || 'file'),
    type: String(f.type || 'application/octet-stream'),
    size: Number(f.size || 0),
    storage_path: String(f.storage_path || ''),
  })).filter(f => f.storage_path);

  /* Require either text or at least one file — but not both empty. */
  if (!messageBody && attachedFiles.length === 0) {
    return res.status(400).json({ error: 'Message must have text or at least one file.' });
  }

  const auth = await authorizeAndLoad(taskId, req.user);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { task, senderName } = auth;

  // Build the row. Mark it pre-read by the sender (no point unreading your own).
  const nowIso = new Date().toISOString();
  const row = {
    id:          uuid(),
    task_id:     taskId,
    sender_id:   req.user.id,
    sender_type: req.user.role,
    sender_name: senderName,
    body:        messageBody || null,
    files:       attachedFiles,
    read_by_client_at: req.user.role === 'client' ? nowIso : null,
    read_by_agent_at:  (req.user.role === 'agent' || req.user.role === 'admin') ? nowIso : null,
    created_at:  nowIso,
  };

  const { data: message, error } = await supabase
    .from('messages')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error('POST message failed', { taskId, error: error.message });
    return res.status(500).json({ error: 'Could not send message' });
  }

  /* Refresh signed URLs before returning so the frontend can render the
     just-sent message with working download links immediately. */
  const messageWithUrls = { ...message, files: await refreshFileUrls(message.files) };

  /* No immediate email on every message — the message notifier worker
     (src/workers/messageNotifier.js) runs every minute and sends a single
     batched notification 15 minutes after the recipient hasn't read it,
     with a 1-email-per-task-per-hour cooldown. See its file for details. */

  logger.info('Message sent', {
    taskId, senderRole: req.user.role, msgId: message.id,
    fileCount: attachedFiles.length,
  });
  res.status(201).json({ message: messageWithUrls });
}));

// ── POST /api/messages/:taskId/upload-url ───────────────────────────────────
// Returns a signed Supabase Storage URL the browser PUTs the file to directly.
router.post('/:taskId/upload-url', asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const { filename, mime_type, size_bytes } = req.body || {};

  const auth = await authorizeAndLoad(taskId, req.user);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  /* Validate filename + extension */
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'filename is required' });
  }
  const safeName = filename.toLowerCase();
  for (const ext of CHAT_BLOCKED_EXTENSIONS) {
    if (safeName.endsWith(ext)) {
      return res.status(400).json({ error: `File type ${ext} is not allowed.` });
    }
  }

  /* Validate MIME */
  if (mime_type) {
    const allowed = CHAT_ALLOWED_MIME_PREFIXES.some(p => mime_type.startsWith(p));
    if (!allowed) {
      return res.status(400).json({
        error: `File type "${mime_type}" is not allowed. Allowed: images, PDFs, Office docs, text, zip.`,
      });
    }
  }

  /* Validate size */
  if (typeof size_bytes === 'number' && size_bytes > CHAT_MAX_FILE_SIZE_BYTES) {
    return res.status(400).json({
      error: `File too large (${Math.round(size_bytes / 1024 / 1024)} MB). Max ${CHAT_MAX_FILE_SIZE_BYTES / 1024 / 1024} MB per file.`,
    });
  }

  const extMatch = filename.match(/\.[a-z0-9]{1,8}$/i);
  const ext = extMatch ? extMatch[0].toLowerCase() : '';
  const storagePath = `${taskId}/${CHAT_FILES_PATH_PREFIX}/${uuid()}${ext}`;

  const { data, error } = await supabase.storage
    .from(CHAT_FILES_BUCKET)
    .createSignedUploadUrl(storagePath);

  if (error) {
    logger.error('Chat file upload URL failed', {
      taskId, error: error.message, path: storagePath,
    });
    return res.status(500).json({
      error: 'Could not start file upload. Storage may not be configured.',
    });
  }

  res.json({
    upload_url: data.signedUrl,
    storage_path: storagePath,
    file_meta: {
      name: filename,
      type: mime_type || 'application/octet-stream',
      size: size_bytes || 0,
      storage_path: storagePath,
    },
  });
}));

// ── GET /api/messages/inbox/all ──────────────────────────────────────────────
// All tasks the user has messages on, with the latest message + unread count.
router.get('/inbox/all', asyncHandler(async (req, res) => {
  let q = supabase
    .from('tasks')
    .select('id, title, status, handler, messages(id, body, sender_type, sender_name, read_by_client_at, read_by_agent_at, created_at)')
    .order('created_at', { ascending: false });

  if (req.user.role === 'client') q = q.eq('client_id', req.user.id);
  if (req.user.role === 'agent')  q = q.eq('agent_id',  req.user.id);
  // admin: no filter

  const { data: tasks, error } = await q;
  if (error) {
    logger.error('inbox failed', { error: error.message });
    return res.status(500).json({ error: 'Could not load inbox' });
  }

  const inbox = (tasks || [])
    .filter(t => t.messages?.length > 0)
    .map(t => {
      const sorted = [...t.messages].sort((a, b) =>
        new Date(a.created_at) - new Date(b.created_at)
      );
      const last = sorted[sorted.length - 1];
      let unread = 0;
      if (req.user.role === 'client') {
        unread = sorted.filter(m => m.sender_type !== 'client' && !m.read_by_client_at).length;
      } else {
        unread = sorted.filter(m => m.sender_type === 'client' && !m.read_by_agent_at).length;
      }
      return {
        task_id:       t.id,
        task_title:    t.title,
        task_status:   t.status,
        task_handler:  t.handler,
        last_message:  last,
        message_count: sorted.length,
        unread_count:  unread,
      };
    });

  res.json({ inbox });
}));

export default router;