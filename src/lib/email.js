import { logger } from './logger.js';

/**
 * Send email via Resend API
 * Falls back to console logging in development
 */
async function sendEmail({ to, subject, html, text }) {
  if (!process.env.RESEND_API_KEY || process.env.NODE_ENV === 'development') {
    logger.info('📧 [DEV] Email would be sent', { to, subject });
    return { id: 'dev-mode', message: 'Email logged in dev mode' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    process.env.EMAIL_FROM || 'Panalo.ai <hello@panalo.ai>',
      to:      [to],
      subject, html, text,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    logger.error('Email send failed', { to, subject, error: err });
    throw new Error(`Email failed: ${err}`);
  }

  const data = await res.json();
  logger.info('Email sent', { to, subject, id: data.id });
  return data;
}

// ── Email templates ──────────────────────────────────────────────────────────

export async function sendWelcomeEmail(user) {
  return sendEmail({
    to:      user.email,
    subject: 'Welcome to Panalo.ai — you\'re in!',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#0f8c7e;padding:32px;border-radius:12px 12px 0 0;text-align:center">
          <h1 style="color:white;margin:0;font-size:28px">Panalo.ai</h1>
          <p style="color:#a0f0e8;margin:8px 0 0">Win with AI + Support</p>
        </div>
        <div style="background:#faf9f6;padding:32px;border-radius:0 0 12px 12px">
          <h2>Welcome, ${user.first_name}! 👋</h2>
          <p>Your account is ready. Here's what to do first:</p>
          <ol>
            <li>Submit your first task from your dashboard</li>
            <li>Watch AI attempt it in real time</li>
            <li>Chat with your agent if it escalates</li>
          </ol>
          <a href="${process.env.FRONTEND_URL}/dashboard" 
             style="display:inline-block;background:#0f8c7e;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
            Go to Dashboard →
          </a>
          <p style="color:#9b948e;font-size:13px;margin-top:24px">
            Questions? Reply to this email or message your agent any time.
          </p>
        </div>
      </div>`,
    text: `Welcome to Panalo.ai, ${user.first_name}! Your account is ready. Go to ${process.env.FRONTEND_URL}/dashboard to submit your first task.`,
  });
}

export async function sendTaskCompletedEmail(user, task, result) {
  const subject = result.handler === 'ai'
    ? `⚡ Task completed by AI — ${task.title.slice(0, 50)}`
    : `✓ Task completed by your agent — ${task.title.slice(0, 50)}`;

  return sendEmail({
    to: user.email, subject,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#0f8c7e;padding:20px 32px;border-radius:12px 12px 0 0">
          <h2 style="color:white;margin:0">Task Complete ✓</h2>
        </div>
        <div style="background:#faf9f6;padding:24px 32px">
          <h3 style="margin-top:0">${task.title}</h3>
          <p><strong>Handled by:</strong> ${result.handler === 'ai' ? '⚡ Panalo AI' : '🤝 ' + result.agent_name}</p>
          <p><strong>Confidence:</strong> ${result.confidence}%</p>
          <div style="background:white;border:1px solid #e2ddd8;border-radius:8px;padding:16px;margin:16px 0">
            <p style="margin:0;color:#3a3630;font-size:14px">${result.output?.slice(0, 300)}${result.output?.length > 300 ? '...' : ''}</p>
          </div>
          <a href="${process.env.FRONTEND_URL}/dashboard/tasks/${task.id}"
             style="display:inline-block;background:#0f8c7e;color:white;padding:10px 20px;border-radius:8px;text-decoration:none">
            View full result →
          </a>
        </div>
      </div>`,
    text: `Your task "${task.title}" has been completed. View it at ${process.env.FRONTEND_URL}/dashboard/tasks/${task.id}`,
  });
}

export async function sendTaskEscalatedEmail(user, task) {
  return sendEmail({
    to: user.email,
    subject: `🤝 Your agent is on it — ${task.title.slice(0, 50)}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#1a1a26;padding:20px 32px;border-radius:12px 12px 0 0">
          <h2 style="color:white;margin:0">Agent Assigned 🤝</h2>
        </div>
        <div style="background:#faf9f6;padding:24px 32px">
          <p>Your task has been picked up by your dedicated Philippine agent. The AI handed off full context so they can jump straight in.</p>
          <h3>${task.title}</h3>
          <p><strong>Expected completion:</strong> ${task.priority === 'urgent' ? 'Within 1 hour' : 'Within 4 hours'}</p>
          <p>You can message your agent directly from the dashboard while they work.</p>
          <a href="${process.env.FRONTEND_URL}/dashboard/tasks/${task.id}"
             style="display:inline-block;background:#1a1a26;color:white;padding:10px 20px;border-radius:8px;text-decoration:none">
            View task & message agent →
          </a>
        </div>
      </div>`,
    text: `Your task "${task.title}" has been assigned to your agent. View at ${process.env.FRONTEND_URL}/dashboard/tasks/${task.id}`,
  });
}

export async function sendAgentMessageEmail(user, task, message) {
  return sendEmail({
    to: user.email,
    subject: `💬 Message from your agent — ${task.title.slice(0, 40)}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#0f8c7e;padding:20px 32px;border-radius:12px 12px 0 0">
          <h2 style="color:white;margin:0">New message from your agent</h2>
        </div>
        <div style="background:#faf9f6;padding:24px 32px">
          <p style="color:#6b6560;font-size:13px">Task: ${task.title}</p>
          <div style="background:white;border-left:3px solid #0f8c7e;padding:12px 16px;border-radius:0 8px 8px 0">
            <p style="margin:0">${message}</p>
          </div>
          <a href="${process.env.FRONTEND_URL}/dashboard/tasks/${task.id}"
             style="display:inline-block;margin-top:16px;background:#0f8c7e;color:white;padding:10px 20px;border-radius:8px;text-decoration:none">
            Reply →
          </a>
        </div>
      </div>`,
    text: `Your agent sent a message on "${task.title}": ${message}. Reply at ${process.env.FRONTEND_URL}/dashboard/tasks/${task.id}`,
  });
}

export async function sendPasswordResetEmail(user, token) {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
  return sendEmail({
    to:      user.email,
    subject: 'Reset your Panalo.ai password',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px">
        <h2>Password Reset</h2>
        <p>Click the link below to reset your password. This link expires in 1 hour.</p>
        <a href="${resetUrl}" style="display:inline-block;background:#0f8c7e;color:white;padding:12px 24px;border-radius:8px;text-decoration:none">
          Reset Password
        </a>
        <p style="color:#9b948e;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
      </div>`,
    text: `Reset your Panalo.ai password: ${resetUrl}`,
  });
}
