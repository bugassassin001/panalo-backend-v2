import { logger } from './logger.js';

/**
 * Send email via Resend API
 * Falls back to console logging in development
 *
 * @param {object} opts
 * @param {string|string[]} opts.to        - Primary recipient(s)
 * @param {string[]}        [opts.bcc]     - BCC recipients (kept hidden from `to`)
 * @param {string|string[]} [opts.replyTo] - Reply-To header (so inbox replies go to a different address)
 * @param {string}          opts.subject
 * @param {string}          [opts.html]
 * @param {string}          [opts.text]
 */
async function sendEmail({ to, bcc, replyTo, subject, html, text }) {
  if (!process.env.RESEND_API_KEY || process.env.NODE_ENV === 'development') {
    logger.info('📧 [DEV] Email would be sent', { to, bcc, replyTo, subject });
    return { id: 'dev-mode', message: 'Email logged in dev mode' };
  }

  // Resend accepts `to` as string or array
  const payload = {
    from:    process.env.EMAIL_FROM || 'Panalo.ai <hello@panalo.ai>',
    to:      Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
  };
  if (bcc && bcc.length)         payload.bcc       = Array.isArray(bcc) ? bcc : [bcc];
  if (replyTo)                   payload.reply_to  = Array.isArray(replyTo) ? replyTo : [replyTo];

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(payload),
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

/**
 * Lead notification — sent to the Panalo team when a guest submits the hero form.
 * Primary recipient is LEADS_TO_EMAIL, with the rest of the team BCC'd.
 * Reply-To is set to the guest's email so hitting Reply in your inbox goes to them.
 */
export async function sendLeadNotificationEmail({ leadEmail, task, ip, userAgent, source, pageUrl }) {
  const to    = process.env.LEADS_TO_EMAIL || 'hello@panalo.ai';
  const bcc   = (process.env.LEADS_BCC || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const when  = new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short',
  });
  const safeTask = String(task || '').slice(0, 2000);
  const preview  = safeTask.length > 80 ? safeTask.slice(0, 80) + '…' : safeTask;
  // Escape HTML in user-provided fields (basic XSS prevention for the email body)
  const esc = (s) => String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');

  return sendEmail({
    to,
    bcc,
    replyTo: leadEmail,
    subject: `[Panalo Lead] ${preview}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;background:#faf9f6;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#0f8c7e,#1a1a26);padding:24px 32px;color:white">
          <div style="font-size:13px;opacity:.85;letter-spacing:.5px">NEW LEAD · PANALO.AI</div>
          <h2 style="margin:6px 0 0;font-size:22px;color:white">A visitor submitted a task</h2>
        </div>
        <div style="padding:24px 32px;color:#2a2520">
          <div style="margin-bottom:18px">
            <div style="font-size:11px;color:#9b948e;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:4px">FROM</div>
            <div style="font-size:15px"><a href="mailto:${esc(leadEmail)}" style="color:#0f8c7e;text-decoration:none;font-weight:600">${esc(leadEmail)}</a></div>
          </div>
          <div style="margin-bottom:18px">
            <div style="font-size:11px;color:#9b948e;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:4px">TASK</div>
            <div style="background:white;border-left:3px solid #0f8c7e;padding:14px 18px;border-radius:0 8px 8px 0;font-size:14px;line-height:1.55;white-space:pre-wrap">${esc(safeTask)}</div>
          </div>
          <table style="width:100%;font-size:13px;color:#6b6560;border-collapse:collapse;margin-top:18px">
            <tr><td style="padding:4px 0;width:120px;color:#9b948e">Received</td><td>${esc(when)} PHT</td></tr>
            <tr><td style="padding:4px 0;color:#9b948e">Source</td><td>${esc(source || 'homepage_hero')}</td></tr>
            ${pageUrl ? `<tr><td style="padding:4px 0;color:#9b948e">Page</td><td><a href="${esc(pageUrl)}" style="color:#0f8c7e">${esc(pageUrl)}</a></td></tr>` : ''}
            ${ip ? `<tr><td style="padding:4px 0;color:#9b948e">IP</td><td>${esc(ip)}</td></tr>` : ''}
            ${userAgent ? `<tr><td style="padding:4px 0;color:#9b948e;vertical-align:top">User agent</td><td style="font-size:11px;color:#9b948e">${esc(userAgent.slice(0, 200))}</td></tr>` : ''}
          </table>
          <div style="margin-top:24px;padding-top:18px;border-top:1px solid #e2ddd8;font-size:13px">
            <strong>Reply directly</strong> — hitting Reply on this email will send to ${esc(leadEmail)} (not to the team alias).
          </div>
        </div>
      </div>`,
    text:
      `New lead from ${leadEmail}\n\n` +
      `Task:\n${safeTask}\n\n` +
      `Received: ${when} PHT\n` +
      `Source: ${source || 'homepage_hero'}\n` +
      (pageUrl ? `Page: ${pageUrl}\n` : '') +
      (ip ? `IP: ${ip}\n` : '') +
      `\nReply directly to ${leadEmail}.`,
  });
}
