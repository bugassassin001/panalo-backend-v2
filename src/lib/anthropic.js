import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger.js';

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const CONFIDENCE_THRESHOLD = parseInt(process.env.AI_CONFIDENCE_THRESHOLD) || 70;

/**
 * Classify a task before attempting it
 */
export async function classifyTask(title, description) {
  const prompt = `Classify this task for an AI task execution platform.

Task title: ${title}
Description: ${description}

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "type": "research|scheduling|writing|data_entry|transcription|customer_support|other",
  "complexity": "simple|medium|complex",
  "estimated_minutes": <number>,
  "can_ai_complete": true|false,
  "tags": ["tag1", "tag2"]
}`;

  try {
    const msg = await anthropic.messages.create({
      model:      process.env.AI_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages:   [{ role: 'user', content: prompt }],
    });
    const raw = msg.content[0].text.trim();
    return JSON.parse(raw);
  } catch (err) {
    logger.warn('Task classification failed, using defaults', { error: err.message });
    return {
      type: 'other', complexity: 'medium',
      estimated_minutes: 10, can_ai_complete: true, tags: [],
    };
  }
}

/**
 * Attempt to complete a task with AI.
 * Returns { output, confidence, steps_taken, escalate }
 */
export async function attemptTask(task) {
  const systemPrompt = `You are Panalo.ai's AI task execution engine. You help US businesses complete operational tasks quickly and accurately.

Your job:
1. Complete the task as fully as possible
2. Be specific and deliver actual output — not advice
3. If you draft content, write the actual draft
4. If you research, give actual findings
5. At the END of your response, on a new line output EXACTLY:
   CONFIDENCE:[0-100] where the number reflects how completely you fulfilled the task
   STEPS:[comma-separated list of what you did]

Rules:
- If the task requires real-world actions (phone calls, calendar access, file system access), explain what you did and what a human needs to finish
- Never refuse to try — always give as much value as possible
- Keep responses under 600 words unless the task truly requires more`;

  const userPrompt = `Complete this task for ${task.client_name || 'the client'}:

TITLE: ${task.title}
DESCRIPTION: ${task.description || task.title}
PRIORITY: ${task.priority}
TYPE: ${task.type}
${task.due_date ? `DUE: ${task.due_date}` : ''}`;

  try {
    const msg = await anthropic.messages.create({
      model:      process.env.AI_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: parseInt(process.env.AI_MAX_TOKENS) || 1500,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    const fullText   = msg.content[0].text;
    const confMatch  = fullText.match(/CONFIDENCE:(\d+)/);
    const stepsMatch = fullText.match(/STEPS:(.+?)(?:\n|$)/);

    const confidence  = confMatch  ? parseInt(confMatch[1])  : 65;
    const steps_taken = stepsMatch ? stepsMatch[1].split(',').map(s => s.trim()) : ['Analyzed task', 'Generated output'];
    const output      = fullText
      .replace(/\nCONFIDENCE:\d+\s*/g, '')
      .replace(/\nSTEPS:.+\s*/g, '')
      .trim();

    const escalate = confidence < CONFIDENCE_THRESHOLD;

    logger.info('AI task attempt complete', {
      task_id:    task.id,
      confidence,
      escalate,
      input_tokens:  msg.usage?.input_tokens,
      output_tokens: msg.usage?.output_tokens,
    });

    return { output, confidence, steps_taken, escalate };
  } catch (err) {
    logger.error('AI task attempt failed', { task_id: task.id, error: err.message });
    return {
      output:      'AI engine encountered an error processing this task. Routing to your human agent.',
      confidence:  0,
      steps_taken: ['Error occurred'],
      escalate:    true,
    };
  }
}

/**
 * Generate a handoff note for agents
 */
export async function generateHandoffNote(task, aiOutput, confidence) {
  const prompt = `You are writing a handoff note for a Philippine support agent who will complete this task.
  
Task: ${task.title}
AI output (${confidence}% confidence): ${aiOutput.slice(0, 500)}

Write a 2-3 sentence agent briefing that:
1. Explains what the AI did/found
2. Says exactly what the agent needs to do to finish
3. Flags anything to watch out for

Be direct and practical. No preamble.`;

  try {
    const msg = await anthropic.messages.create({
      model:      process.env.AI_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages:   [{ role: 'user', content: prompt }],
    });
    return msg.content[0].text.trim();
  } catch {
    return `AI attempted this task at ${confidence}% confidence. Please review the AI output and complete what's missing. Pay attention to any items the AI flagged as uncertain.`;
  }
}

/**
 * Generate a quick AI preview for the task submission UI
 */
export async function previewTask(description) {
  const msg = await anthropic.messages.create({
    model:      process.env.AI_MODEL || 'claude-sonnet-4-20250514',
    max_tokens: 150,
    system:     'You are Panalo.ai\'s AI. Given a task description, respond in 2-3 sentences explaining how you\'ll approach it and what you\'ll deliver. Be specific and confident. End with [Confidence: XX%].',
    messages:   [{ role: 'user', content: description }],
  });
  return msg.content[0].text.trim();
}
