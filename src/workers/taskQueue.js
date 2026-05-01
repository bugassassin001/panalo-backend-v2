import Bull from 'bull';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { attemptTask, generateHandoffNote, classifyTask } from '../lib/anthropic.js';
import { sendTaskCompletedEmail, sendTaskEscalatedEmail } from '../lib/email.js';

let taskQueue = null;

export async function initQueue() {
  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set — task queue disabled, processing synchronously');
    return;
  }

  taskQueue = new Bull('panalo-tasks', {
    redis: process.env.REDIS_URL,
    defaultJobOptions: {
      attempts: 3,
      backoff:  { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail:     50,
    },
  });

  // ── Process AI task jobs ──────────────────────────────────────────────────
  taskQueue.process('process-task', 5, async (job) => {
    const { taskId } = job.data;
    logger.info('Processing task from queue', { taskId, attempt: job.attemptsMade + 1 });
    await processTaskJob(taskId);
  });

  taskQueue.on('completed', (job) => {
    logger.info('Task job completed', { jobId: job.id, taskId: job.data.taskId });
  });

  taskQueue.on('failed', (job, err) => {
    logger.error('Task job failed', { jobId: job.id, taskId: job.data.taskId, error: err.message });
  });

  logger.info('Task queue initialized', { redis: process.env.REDIS_URL });
}

/**
 * Add a task to the processing queue (or process immediately if no queue)
 */
export async function enqueueTask(taskId) {
  if (taskQueue) {
    await taskQueue.add('process-task', { taskId }, { delay: 500 });
    logger.info('Task enqueued', { taskId });
  } else {
    // No Redis — process inline (fine for MVP/dev)
    setImmediate(() => processTaskJob(taskId).catch(err => {
      logger.error('Inline task processing failed', { taskId, error: err.message });
    }));
  }
}

/**
 * Core task processing logic — runs in queue worker or inline
 */
export async function processTaskJob(taskId) {
  // 1. Fetch task
  const { data: task, error } = await supabase
    .from('tasks')
    .select('*, users(email, first_name, last_name)')
    .eq('id', taskId)
    .single();

  if (error || !task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // 2. Mark as processing
  await supabase.from('tasks').update({
    status:     'processing',
    updated_at: new Date().toISOString(),
  }).eq('id', taskId);

  // 3. Classify if not already done
  if (!task.type || task.type === 'other') {
    try {
      const classification = await classifyTask(task.title, task.description);
      await supabase.from('tasks').update({
        type:               classification.type,
        complexity:         classification.complexity,
        estimated_minutes:  classification.estimated_minutes,
        tags:               classification.tags,
      }).eq('id', taskId);
      Object.assign(task, classification);
    } catch (err) {
      logger.warn('Classification failed, continuing', { taskId, error: err.message });
    }
  }

  // 4. AI attempt
  const aiResult = await attemptTask({
    ...task,
    client_name: task.users
      ? `${task.users.first_name} ${task.users.last_name}`
      : 'the client',
  });

  const { output, confidence, steps_taken, escalate } = aiResult;

  // 5. Save AI result
  await supabase.from('task_results').insert({
    task_id:     taskId,
    output,
    confidence,
    steps_taken,
    handler:     'ai',
    created_at:  new Date().toISOString(),
  });

  // 6. Add system message from AI
  await supabase.from('messages').insert({
    task_id:    taskId,
    sender_id:  null, // system
    sender_type:'ai',
    body:       output.slice(0, 1000) + (output.length > 1000 ? '...' : ''),
    created_at: new Date().toISOString(),
  });

  // 7. Route based on confidence
  if (!escalate) {
    // ── AUTO COMPLETE ────────────────────────────────────────────────────────
    await supabase.from('tasks').update({
      status:       'completed',
      handler:      'ai',
      completed_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    }).eq('id', taskId);

    // Notify client
    if (task.users?.email) {
      await sendTaskCompletedEmail(task.users, task, {
        handler:    'ai',
        confidence,
        output,
      }).catch(err => logger.warn('Email failed', { error: err.message }));
    }

    logger.info('Task auto-completed by AI', { taskId, confidence });

  } else {
    // ── ESCALATE TO AGENT ───────────────────────────────────────────────────
    const handoffNote = await generateHandoffNote(task, output, confidence);

    // Find available agent (simple round-robin)
    const { data: agent } = await supabase
      .from('agents')
      .select('id, name, email')
      .eq('status', 'online')
      .order('current_tasks', { ascending: true })
      .limit(1)
      .single();

    await supabase.from('tasks').update({
      status:      'assigned',
      handler:     'human',
      agent_id:    agent?.id || null,
      ai_note:     handoffNote,
      updated_at:  new Date().toISOString(),
    }).eq('id', taskId);

    // Increment agent task count
    if (agent) {
      await supabase.rpc('increment_agent_tasks', { agent_id: agent.id });
    }

    // Add handoff message in thread
    await supabase.from('messages').insert({
      task_id:    taskId,
      sender_id:  null,
      sender_type:'system',
      body:       `Task escalated to human agent. AI confidence was ${confidence}%. Agent briefed and taking over.`,
      created_at: new Date().toISOString(),
    });

    // Notify client
    if (task.users?.email) {
      await sendTaskEscalatedEmail(task.users, task)
        .catch(err => logger.warn('Email failed', { error: err.message }));
    }

    logger.info('Task escalated to human agent', { taskId, confidence, agentId: agent?.id });
  }
}
