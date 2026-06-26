import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { logger } from '../lib/logger.js';

const router = Router();
router.use(requireAuth);

/* ─── Constants ───────────────────────────────────────────── */
const BUCKET                = 'task-notes';
const MAX_FILES_PER_NOTE    = 5;
const MAX_FILE_SIZE_BYTES   = 25 * 1024 * 1024; // 25 MB
const SIGNED_UPLOAD_TTL_SEC = 60 * 5;            // 5 minutes to upload after signing
const SIGNED_READ_TTL_SEC   = 60 * 60 * 24;      // 24h read URL — refreshed on each GET
const ALLOWED_MIME_PREFIXES = [
  'image/',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument',  // .docx, .xlsx, .pptx
  'application/vnd.ms-',                             // older office formats
  'application/msword',
  'text/',
  'application/zip',
  'application/x-zip-compressed',
  'application/json',
];
/* Block executables and scripts even if their MIME slips through */
const BLOCKED_EXTENSIONS = [
  '.exe', '.bat', '.cmd', '.com', '.sh', '.app', '.dmg',
  '.jar', '.msi', '.scr', '.vbs', '.ps1', '.apk', '.deb', '.rpm',
];

/* ─── Authorization helper ────────────────────────────────── */
async function authorizeAndLoadTask(taskId, user) {
  const { data: task, error } = await supabase
    .from('tasks').select('id, client_id, agent_id, status').eq('id', taskId).single();
  if (error || !task) return { error: 'Task not found', status: 404 };

  if (user.role === 'client' && task.client_id !== user.id)
    return { error: 'You do not own this task', status: 403 };
  if (user.role === 'agent' && task.agent_id !== user.id)
    return { error: 'This task is not assigned to you', status: 403 };
  /* admin: no restriction */

  return { task };
}

async function getAuthorName(userId) {
  if (!userId) return null;
  const { data } = await supabase
    .from('users').select('first_name, last_name, email').eq('id', userId).single();
  if (!data) return null;
  return `${data.first_name || ''} ${data.last_name || ''}`.trim() || data.email || null;
}

/* Refresh signed read URLs for files stored as private objects. We store the
   storage_path in the JSON; the URL we hand to the browser is short-lived. */
async function refreshFileUrls(files) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const paths = files.map(f => f.storage_path).filter(Boolean);
  if (paths.length === 0) return files;

  /* createSignedUrls returns URLs in the same order as input paths */
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(paths, SIGNED_READ_TTL_SEC);

  if (error) {
    logger.warn('refreshFileUrls failed', { error: error.message });
    return files; // return original; frontend will show stale URLs (may 401 but won't crash)
  }

  return files.map((f, i) => ({
    ...f,
    url: data[i]?.signedUrl || f.url,
  }));
}

/* ─── GET /api/notes/:taskId ────────────────────────────────
   List all notes for a task, newest-first. File URLs are re-signed each call
   so they're always fresh (storage is private). */
router.get('/:taskId', asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const auth = await authorizeAndLoadTask(taskId, req.user);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const { data: notes, error } = await supabase
    .from('task_notes')
    .select('id, task_id, author_id, author_role, author_name, content, files, created_at, updated_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('GET notes failed', { taskId, error: error.message });
    return res.status(500).json({ error: 'Could not load notes' });
  }

  /* Refresh signed URLs for each note's files (parallel) */
  const withFreshUrls = await Promise.all(
    (notes || []).map(async n => ({ ...n, files: await refreshFileUrls(n.files) }))
  );

  res.json({
    notes: withFreshUrls,
    viewer_role: req.user.role,
    viewer_user_id: req.user.id,
  });
}));

/* ─── POST /api/notes/:taskId/upload-url ────────────────────
   Returns a signed UPLOAD URL the browser can PUT a file to directly.
   The browser doesn't proxy the file through our backend — that would be
   slow, consume Railway bandwidth, and hit the 10MB body limit. Direct upload
   is the standard pattern for Supabase Storage. */
router.post('/:taskId/upload-url', asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const { filename, mime_type, size_bytes } = req.body || {};

  const auth = await authorizeAndLoadTask(taskId, req.user);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  /* Validate filename */
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'filename is required' });
  }
  const safe = filename.toLowerCase();
  for (const ext of BLOCKED_EXTENSIONS) {
    if (safe.endsWith(ext)) {
      return res.status(400).json({ error: `File type ${ext} is not allowed.` });
    }
  }

  /* Validate MIME type */
  if (mime_type) {
    const allowed = ALLOWED_MIME_PREFIXES.some(p => mime_type.startsWith(p));
    if (!allowed) {
      return res.status(400).json({
        error: `File type "${mime_type}" is not allowed. Allowed: images, PDFs, Office documents, text, zip.`,
      });
    }
  }

  /* Validate size */
  if (typeof size_bytes === 'number' && size_bytes > MAX_FILE_SIZE_BYTES) {
    return res.status(400).json({
      error: `File too large (${Math.round(size_bytes / 1024 / 1024)} MB). Max ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB per file.`,
    });
  }

  /* Build a unique path: task-id/uuid.ext. We prefix with task ID so RLS can
     match on path (if you add storage policies later) and so files for a task
     are easy to clean up if the task is deleted. */
  const extMatch = filename.match(/\.[a-z0-9]{1,8}$/i);
  const ext = extMatch ? extMatch[0].toLowerCase() : '';
  const storagePath = `${taskId}/${uuid()}${ext}`;

  /* createSignedUploadUrl gives the browser a one-shot URL to PUT to */
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(storagePath);

  if (error) {
    logger.error('createSignedUploadUrl failed', {
      taskId, error: error.message, path: storagePath,
    });
    return res.status(500).json({
      error: 'Could not start file upload. Storage may not be configured.',
    });
  }

  res.json({
    upload_url: data.signedUrl,
    storage_path: storagePath,
    /* Echo back what the frontend should include in the POST /notes call
       so the file metadata is correctly attached to the note. */
    file_meta: {
      name: filename,
      type: mime_type || 'application/octet-stream',
      size: size_bytes || 0,
      storage_path: storagePath,
    },
    /* Note: the browser still needs to call POST /api/notes/:taskId after
       upload completes, attaching this file_meta in the files array. */
  });
}));

/* ─── POST /api/notes/:taskId ───────────────────────────────
   Create a note. Body: { content?: string, files?: array }
   Either content OR at least one file is required. */
router.post('/:taskId', asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const content = (req.body?.content || '').trim();
  const files = Array.isArray(req.body?.files) ? req.body.files : [];

  if (!content && files.length === 0) {
    return res.status(400).json({ error: 'Note must have text or at least one file.' });
  }
  if (content.length > 5000) {
    return res.status(400).json({ error: 'Note text is too long (max 5,000 characters).' });
  }
  if (files.length > MAX_FILES_PER_NOTE) {
    return res.status(400).json({ error: `Too many files (max ${MAX_FILES_PER_NOTE} per note).` });
  }

  const auth = await authorizeAndLoadTask(taskId, req.user);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  /* Validate file entries — each must have at least name + storage_path so
     we know what got uploaded and where. Strip any unexpected fields. */
  const cleanFiles = files.map(f => ({
    name: String(f.name || 'file'),
    type: String(f.type || 'application/octet-stream'),
    size: Number(f.size || 0),
    storage_path: String(f.storage_path || ''),
  })).filter(f => f.storage_path);

  const authorName = await getAuthorName(req.user.id);

  const row = {
    id:          uuid(),
    task_id:     taskId,
    author_id:   req.user.id,
    author_role: req.user.role,
    author_name: authorName,
    content:     content || null,
    files:       cleanFiles,
    created_at:  new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('task_notes')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error('POST note insert failed', { taskId, error: error.message });
    return res.status(500).json({ error: 'Could not save the note.' });
  }

  /* Touch the parent task's updated_at so it sorts to the top of lists */
  supabase.from('tasks')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', taskId)
    .then(() => {}, () => {});

  /* Return with refreshed signed URLs so the frontend can render immediately */
  const refreshedFiles = await refreshFileUrls(data.files);
  logger.info('Note created', {
    taskId, noteId: data.id, authorRole: req.user.role, fileCount: cleanFiles.length,
  });
  res.status(201).json({ note: { ...data, files: refreshedFiles } });
}));

/* ─── DELETE /api/notes/:noteId ─────────────────────────────
   Author can delete their own notes; admins can delete any. Cleans up files
   in Storage too. */
router.delete('/:noteId', asyncHandler(async (req, res) => {
  const { noteId } = req.params;

  const { data: note, error } = await supabase
    .from('task_notes').select('*').eq('id', noteId).single();
  if (error || !note) return res.status(404).json({ error: 'Note not found' });

  /* Authorization: author or admin */
  const isAuthor = note.author_id === req.user.id;
  const isAdmin  = req.user.role === 'admin';
  if (!isAuthor && !isAdmin) {
    return res.status(403).json({ error: 'You can only delete your own notes.' });
  }

  /* Also confirm the requester has access to the parent task (defense in depth) */
  const taskAuth = await authorizeAndLoadTask(note.task_id, req.user);
  if (taskAuth.error) return res.status(taskAuth.status).json({ error: taskAuth.error });

  /* Delete attached files from Storage. Best-effort — even if storage delete
     fails, we still delete the DB row so the note disappears from the UI. */
  const paths = (Array.isArray(note.files) ? note.files : [])
    .map(f => f.storage_path).filter(Boolean);
  if (paths.length > 0) {
    const { error: storageErr } = await supabase.storage.from(BUCKET).remove(paths);
    if (storageErr) {
      logger.warn('Note file delete failed (continuing with row delete)', {
        noteId, error: storageErr.message,
      });
    }
  }

  const { error: delErr } = await supabase
    .from('task_notes').delete().eq('id', noteId);
  if (delErr) {
    logger.error('Note delete failed', { noteId, error: delErr.message });
    return res.status(500).json({ error: 'Could not delete the note.' });
  }

  logger.info('Note deleted', { noteId, by: req.user.id });
  res.json({ message: 'Note deleted', id: noteId });
}));

export default router;
