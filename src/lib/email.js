import { logger } from './logger.js';

/**
 * Send email via Resend API. Supports to / bcc / replyTo.
 */
async function sendEmail({ to, bcc, replyTo, subject, html, text }) {
  if (!process.env.RESEND_API_KEY || process.env.NODE_ENV === 'development') {
    logger.info('📧 [DEV] Email would be sent', { to, bcc, replyTo, subject });
    return { id: 'dev-mode', message: 'Email logged in dev mode' };
  }

  const payload = {
    from:    process.env.EMAIL_FROM || 'Panalo.ai <hello@panalo.ai>',
    to:      Array.isArray(to) ? to : [to],
    subject, html, text,
  };
  if (bcc && bcc.length)  payload.bcc      = Array.isArray(bcc) ? bcc : [bcc];
  if (replyTo)            payload.reply_to = Array.isArray(replyTo) ? replyTo : [replyTo];

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

const esc = (s) => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#039;');

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
          <h2>Welcome, ${esc(user.first_name)}! 👋</h2>
          <p>Your account is ready.</p>
          <a href="${process.env.FRONTEND_URL}/dashboard"
             style="display:inline-block;background:#0f8c7e;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
            Go to Dashboard →
          </a>
        </div>
      </div>`,
    text: `Welcome to Panalo.ai, ${user.first_name}! Go to ${process.env.FRONTEND_URL}/dashboard.`,
  });
}

/**
 * Sent to the client when their task is marked complete.
 * Supports two call signatures for backwards compatibility:
 *   sendTaskCompletedEmail(user, task, result)         // legacy
 *   sendTaskCompletedEmail({ client, task, summary, agentName })  // new
 */
export async function sendTaskCompletedEmail(arg1, task2, result) {
  let client, task, summary = '', agentName = 'Your agent';
  if (arg1 && typeof arg1 === 'object' && arg1.client) {
    client    = arg1.client;
    task      = arg1.task;
    summary   = arg1.summary || '';
    agentName = arg1.agentName || 'Your agent';
  } else {
    client    = arg1;
    task      = task2;
    summary   = (result && typeof result === 'object' && result.summary) || '';
    agentName = (result && typeof result === 'object' && result.agentName) || 'Your agent';
  }
  if (!client || !client.email || !task) return;

  const baseUrl = (process.env.FRONTEND_URL || 'https://www.panalo.ai').split(',')[0].trim();
  const dashUrl = `${baseUrl}/dashboard.html`;

  const taskTitle = String(task.title || 'Your task').slice(0, 80);
  const summaryHtml = summary
    ? `<div style="background:white;border-left:3px solid #0f8c7e;padding:14px 18px;border-radius:0 8px 8px 0;margin:18px 0;font-size:14px;color:#3a3630;line-height:1.6;white-space:pre-wrap">${esc(summary)}</div>`
    : '';

  return sendEmail({
    to: client.email,
    subject: `✓ Task completed — ${taskTitle}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;background:#faf9f6;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#0f8c7e,#1a1a26);padding:24px 28px;color:white">
          <div style="font-size:13px;opacity:.85;letter-spacing:.5px">PANALO.AI</div>
          <h2 style="margin:6px 0 0;font-size:22px;color:white">✓ Task completed</h2>
        </div>
        <div style="padding:24px 28px;color:#2a2520;font-size:15px;line-height:1.6">
          <p style="margin:0 0 14px">Hi ${esc(client.first_name || 'there')},</p>
          <p style="margin:0 0 14px">${esc(agentName)} has just marked your task as complete:</p>
          <div style="font-size:14px;font-weight:600;margin:14px 0 6px">"${esc(taskTitle)}"</div>
          ${summaryHtml}
          <div style="text-align:center;margin:22px 0 8px">
            <a href="${dashUrl}" style="display:inline-block;background:#0f8c7e;color:white;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">
              Open dashboard →
            </a>
          </div>
          <p style="margin:18px 0 0;font-size:13px;color:#6b6560">
            If anything's not quite right, you can reopen the task from your dashboard or just reply to this email.
          </p>
          <p style="margin:14px 0 0;font-size:12px;color:#9b948e">— The Panalo.ai team</p>
        </div>
      </div>`,
    text:
      `Hi ${client.first_name || 'there'},\n\n` +
      `${agentName} just marked your task complete:\n\n` +
      `"${taskTitle}"\n\n` +
      (summary ? `${summary}\n\n` : '') +
      `View on your dashboard: ${dashUrl}\n\n` +
      `If anything's not right, you can reopen the task or reply to this email.\n\n` +
      `— The Panalo.ai team`,
  });
}

export async function sendTaskEscalatedEmail(user, task) {
  return sendEmail({
    to: user.email,
    subject: `🤝 Your agent is on it — ${task.title.slice(0, 50)}`,
    html: `<p>${esc(task.title)} — escalated to your agent.</p>`,
    text: `Your task "${task.title}" has been assigned to your agent.`,
  });
}

export async function sendAgentMessageEmail(user, task, message) {
  return sendEmail({
    to: user.email,
    subject: `💬 Message from your agent — ${task.title.slice(0, 40)}`,
    html: `<p>${esc(message)}</p>`,
    text: `Agent message on "${task.title}": ${message}`,
  });
}

export async function sendPasswordResetEmail(user, token) {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
  return sendEmail({
    to:      user.email,
    subject: 'Reset your Panalo.ai password',
    html: `<p><a href="${resetUrl}">Reset your password</a></p>`,
    text: `Reset your Panalo.ai password: ${resetUrl}`,
  });
}

/**
 * Lead notification — sent to the team when a guest submits the hero form.
 * Optionally includes AI output + confidence for context.
 */
export async function sendLeadNotificationEmail({
  leadEmail, task, ip, userAgent, source, pageUrl,
  aiOutput, aiConfidence,
}) {
  const to    = process.env.LEADS_TO_EMAIL || 'hello@panalo.ai';
  const bcc   = (process.env.LEADS_BCC || '').split(',').map(s => s.trim()).filter(Boolean);
  const when  = new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short',
  });
  const safeTask = String(task || '').slice(0, 2000);
  const preview  = safeTask.length > 80 ? safeTask.slice(0, 80) + '…' : safeTask;

  const aiSection = aiOutput ? `
    <div style="margin:18px 0">
      <div style="font-size:11px;color:#9b948e;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:4px">
        AI ATTEMPTED — ${aiConfidence ?? '?'}% CONFIDENCE
      </div>
      <div style="background:#fff;border:1px solid #e2ddd8;border-radius:8px;padding:14px 18px;font-size:13px;line-height:1.55;white-space:pre-wrap;color:#3a3630">${esc(aiOutput)}</div>
    </div>
  ` : '';

  return sendEmail({
    to, bcc,
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
          ${aiSection}
          <table style="width:100%;font-size:13px;color:#6b6560;border-collapse:collapse;margin-top:18px">
            <tr><td style="padding:4px 0;width:120px;color:#9b948e">Received</td><td>${esc(when)} PHT</td></tr>
            <tr><td style="padding:4px 0;color:#9b948e">Source</td><td>${esc(source || 'homepage_hero')}</td></tr>
            ${pageUrl ? `<tr><td style="padding:4px 0;color:#9b948e">Page</td><td><a href="${esc(pageUrl)}" style="color:#0f8c7e">${esc(pageUrl)}</a></td></tr>` : ''}
            ${ip ? `<tr><td style="padding:4px 0;color:#9b948e">IP</td><td>${esc(ip)}</td></tr>` : ''}
          </table>
          <div style="margin-top:24px;padding-top:18px;border-top:1px solid #e2ddd8;font-size:13px">
            <strong>Reply directly</strong> — hitting Reply on this email will send to ${esc(leadEmail)} (not to the team alias).
          </div>
        </div>
      </div>`,
    text:
      `New lead from ${leadEmail}\n\n` +
      `Task:\n${safeTask}\n\n` +
      (aiOutput ? `AI attempted (${aiConfidence ?? '?'}% confidence):\n${aiOutput}\n\n` : '') +
      `Received: ${when} PHT\n` +
      `Source: ${source || 'homepage_hero'}\n` +
      (pageUrl ? `Page: ${pageUrl}\n` : '') +
      `\nReply directly to ${leadEmail}.`,
  });
}

/**
 * Escalation email — sent when the visitor clicks "Request Human Review"
 * after seeing the AI preview. Higher urgency styling, includes AI output.
 */
export async function sendLeadEscalationEmail({
  leadEmail, task, aiOutput, aiConfidence, reason, leadId, submittedAt,
}) {
  const to    = process.env.LEADS_TO_EMAIL || 'hello@panalo.ai';
  const bcc   = (process.env.LEADS_BCC || '').split(',').map(s => s.trim()).filter(Boolean);
  const when  = new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short',
  });
  const safeTask = String(task || '').slice(0, 2000);
  const preview  = safeTask.length > 60 ? safeTask.slice(0, 60) + '…' : safeTask;

  return sendEmail({
    to, bcc,
    replyTo: leadEmail,
    subject: `🚨 [Human Review Requested] ${preview}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;background:#faf9f6;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#d97706,#b45309);padding:24px 32px;color:white">
          <div style="font-size:13px;opacity:.9;letter-spacing:.5px">🚨 HUMAN REVIEW REQUESTED · PANALO.AI</div>
          <h2 style="margin:6px 0 0;font-size:22px;color:white">Visitor wants a human to review their task</h2>
        </div>
        <div style="padding:24px 32px;color:#2a2520">
          <div style="background:#fef3c7;border-left:3px solid #d97706;border-radius:0 8px 8px 0;padding:12px 16px;margin-bottom:20px;font-size:14px">
            <strong>Action needed:</strong> Reply to ${esc(leadEmail)} within 2 hours to confirm their request and discuss next steps.
          </div>
          <div style="margin-bottom:18px">
            <div style="font-size:11px;color:#9b948e;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:4px">FROM</div>
            <div style="font-size:15px"><a href="mailto:${esc(leadEmail)}" style="color:#0f8c7e;text-decoration:none;font-weight:600">${esc(leadEmail)}</a></div>
          </div>
          <div style="margin-bottom:18px">
            <div style="font-size:11px;color:#9b948e;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:4px">ORIGINAL TASK</div>
            <div style="background:white;border-left:3px solid #0f8c7e;padding:14px 18px;border-radius:0 8px 8px 0;font-size:14px;line-height:1.55;white-space:pre-wrap">${esc(safeTask)}</div>
          </div>
          ${aiOutput ? `
          <div style="margin-bottom:18px">
            <div style="font-size:11px;color:#9b948e;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:4px">
              WHAT AI ALREADY ATTEMPTED — ${aiConfidence ?? '?'}% CONFIDENCE
            </div>
            <div style="background:#fff;border:1px solid #e2ddd8;border-radius:8px;padding:14px 18px;font-size:13px;line-height:1.55;white-space:pre-wrap;color:#3a3630">${esc(aiOutput)}</div>
            <div style="font-size:12px;color:#9b948e;margin-top:6px;font-style:italic">The visitor saw this AI response and chose to request a human review instead.</div>
          </div>
          ` : ''}
          ${reason ? `
          <div style="margin-bottom:18px">
            <div style="font-size:11px;color:#9b948e;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:4px">VISITOR'S NOTE</div>
            <div style="background:white;border:1px solid #e2ddd8;border-radius:8px;padding:12px 16px;font-size:14px;color:#3a3630">${esc(reason)}</div>
          </div>
          ` : ''}
          <table style="width:100%;font-size:13px;color:#6b6560;border-collapse:collapse;margin-top:18px">
            <tr><td style="padding:4px 0;width:130px;color:#9b948e">Escalated at</td><td>${esc(when)} PHT</td></tr>
            <tr><td style="padding:4px 0;color:#9b948e">Lead ID</td><td style="font-family:monospace;font-size:11px">${esc(leadId)}</td></tr>
          </table>
          <div style="margin-top:24px;padding-top:18px;border-top:1px solid #e2ddd8;font-size:13px">
            <strong>Reply directly</strong> — hitting Reply goes to ${esc(leadEmail)}.
          </div>
        </div>
      </div>`,
    text:
      `[HUMAN REVIEW REQUESTED] ${leadEmail}\n\n` +
      `Task:\n${safeTask}\n\n` +
      (aiOutput ? `AI attempted (${aiConfidence ?? '?'}% confidence):\n${aiOutput}\n\n` : '') +
      (reason ? `Visitor's note: ${reason}\n\n` : '') +
      `Escalated: ${when} PHT\n` +
      `Lead ID: ${leadId}\n\n` +
      `ACTION: Reply to ${leadEmail} within 2 hours.`,
  });
}

/**
 * Visitor escalation confirmation — short acknowledgment sent TO the visitor
 * after they click "Request Human Review". Now also includes a prominent
 * "Track this task" CTA so they can convert to a registered user with one click.
 */
export async function sendVisitorEscalationConfirmation({ visitorEmail, task, leadId, signupToken }) {
  const safeTask = String(task || '').slice(0, 2000);
  const preview  = safeTask.length > 60 ? safeTask.slice(0, 60) + '…' : safeTask;
  const replyTo  = process.env.LEADS_TO_EMAIL || 'hello@panalo.ai';

  // Build the "Track this task" link. Frontend URL + signup page + token + prefilled email.
  // The frontend reads ?signup_token=... and ?email=... to pre-fill the signup form.
  const baseUrl = (process.env.FRONTEND_URL || 'https://www.panalo.ai').split(',')[0].trim();
  const trackUrl = signupToken
    ? `${baseUrl}/index.html?signup_token=${encodeURIComponent(signupToken)}&email=${encodeURIComponent(visitorEmail)}&from=escalation#signup`
    : null;

  const trackButtonHtml = trackUrl ? `
    <div style="text-align:center;margin:24px 0 8px">
      <a href="${trackUrl}" style="display:inline-block;background:#0f8c7e;color:white;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:.2px">
        📊 Track this task →
      </a>
    </div>
    <p style="font-size:12px;color:#9b948e;text-align:center;margin:8px 0 0">
      Create a free account to follow progress, message your agent, and submit more tasks.
    </p>
  ` : '';

  const trackTextLine = trackUrl
    ? `\nWant to follow this task's progress? Track it here: ${trackUrl}\n`
    : '';

  return sendEmail({
    to:      visitorEmail,
    replyTo,
    subject: 'We got your task — a human is on it',
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:0 auto;background:#faf9f6;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#0f8c7e,#1a1a26);padding:24px 28px;color:white">
          <div style="font-size:13px;opacity:.85;letter-spacing:.5px">PANALO.AI</div>
          <h2 style="margin:6px 0 0;font-size:22px;color:white">We've got it from here 🤝</h2>
        </div>
        <div style="padding:24px 28px;color:#2a2520;font-size:15px;line-height:1.6">
          <p style="margin:0 0 14px">Hi there,</p>
          <p style="margin:0 0 14px">Thanks for sending this our way — a member of our Philippine team will be in touch within <strong>2 hours</strong> to help you complete it.</p>
          <div style="background:white;border-left:3px solid #0f8c7e;padding:12px 16px;border-radius:0 8px 8px 0;margin:18px 0;font-size:14px;color:#3a3630">
            <div style="font-size:11px;color:#9b948e;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:4px">YOUR TASK</div>
            ${esc(preview)}
          </div>
          ${trackButtonHtml}
          <p style="margin:18px 0 14px;font-size:14px;color:#6b6560">
            Or just reply to this email if you need to add anything — your reply goes straight to our team.
          </p>
          <p style="margin:18px 0 0;font-size:13px;color:#9b948e">
            — The Panalo.ai team
          </p>
        </div>
      </div>`,
    text:
      `Hi there,\n\n` +
      `Thanks for sending this our way — a member of our Philippine team will be in touch within 2 hours.\n\n` +
      `Your task:\n${preview}\n${trackTextLine}` +
      `\nOr just reply to this email if you need to add anything.\n\n` +
      `— The Panalo.ai team`,
  });
}

/**
 * Visitor accept-result confirmation — sent when a visitor clicks "Accept Result"
 * on the AI preview. Confirms the result was saved and offers signup so they can
 * keep it on their dashboard.
 */
export async function sendVisitorAcceptConfirmation({ visitorEmail, task, aiOutput, aiConfidence, leadId, signupToken }) {
  const safeTask = String(task || '').slice(0, 2000);
  const preview  = safeTask.length > 60 ? safeTask.slice(0, 60) + '…' : safeTask;
  const safeAi   = String(aiOutput || '').slice(0, 800);
  const aiSnippet = safeAi.length > 400 ? safeAi.slice(0, 400) + '…' : safeAi;
  const replyTo  = process.env.LEADS_TO_EMAIL || 'hello@panalo.ai';

  const baseUrl = (process.env.FRONTEND_URL || 'https://www.panalo.ai').split(',')[0].trim();
  const trackUrl = signupToken
    ? `${baseUrl}/index.html?signup_token=${encodeURIComponent(signupToken)}&email=${encodeURIComponent(visitorEmail)}&from=accept#signup`
    : null;

  const ctaHtml = trackUrl ? `
    <div style="text-align:center;margin:24px 0 8px">
      <a href="${trackUrl}" style="display:inline-block;background:#0f8c7e;color:white;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:.2px">
        💾 Save to your dashboard →
      </a>
    </div>
    <p style="font-size:12px;color:#9b948e;text-align:center;margin:8px 0 0">
      Create a free account to keep this result and easily revisit it later.
    </p>
  ` : '';

  const ctaText = trackUrl
    ? `\nSave this to your dashboard (free account): ${trackUrl}\n`
    : '';

  return sendEmail({
    to:      visitorEmail,
    replyTo,
    subject: 'Your AI result is ready ⚡',
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;background:#faf9f6;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#0f8c7e,#1a1a26);padding:24px 28px;color:white">
          <div style="font-size:13px;opacity:.85;letter-spacing:.5px">PANALO.AI</div>
          <h2 style="margin:6px 0 0;font-size:22px;color:white">Here's a copy for your records ⚡</h2>
        </div>
        <div style="padding:24px 28px;color:#2a2520;font-size:15px;line-height:1.6">
          <p style="margin:0 0 14px">Hi there,</p>
          <p style="margin:0 0 14px">Thanks for trying Panalo AI! Here's the result of what you asked us to do.</p>
          <div style="background:white;border-left:3px solid #0f8c7e;padding:12px 16px;border-radius:0 8px 8px 0;margin:18px 0;font-size:14px;color:#3a3630">
            <div style="font-size:11px;color:#9b948e;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:4px">YOUR TASK</div>
            ${esc(preview)}
          </div>
          ${aiSnippet ? `
          <div style="background:#fff;border:1px solid #e2ddd8;border-radius:8px;padding:14px 18px;margin:14px 0;font-size:13px;line-height:1.55;white-space:pre-wrap;color:#3a3630">
            <div style="font-size:11px;color:#9b948e;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:6px">AI RESULT ${aiConfidence ? `— ${aiConfidence}% CONFIDENCE` : ''}</div>
            ${esc(aiSnippet)}
          </div>
          ` : ''}
          ${ctaHtml}
          <p style="margin:18px 0 14px;font-size:14px;color:#6b6560">
            Need a human to take a closer look? Just reply to this email — we're here.
          </p>
          <p style="margin:18px 0 0;font-size:13px;color:#9b948e">
            — The Panalo.ai team
          </p>
        </div>
      </div>`,
    text:
      `Hi there,\n\n` +
      `Here's the result of what you asked Panalo AI to do.\n\n` +
      `Your task:\n${preview}\n\n` +
      (aiSnippet ? `AI result${aiConfidence ? ` (${aiConfidence}% confidence)` : ''}:\n${aiSnippet}\n` : '') +
      `${ctaText}\n` +
      `Need a human's eyes? Just reply to this email.\n\n` +
      `— The Panalo.ai team`,
  });
}

/**
 * Agent/admin invitation — sent when an admin creates a new team member.
 * Includes a single-use "Set your password" link with a 7-day expiry.
 *
 * Also used as a notification-only template (role='notification_only') to alert
 * other admins when a new admin is created, so suspicious activity is visible.
 */
export async function sendAgentInviteEmail({
  inviteeEmail, inviteeName, inviterName, role, token, isResend, notificationOf,
}) {
  const baseUrl = (process.env.FRONTEND_URL || 'https://www.panalo.ai').split(',')[0].trim();

  // Notification-only mode: alert existing admins of a new admin
  if (role === 'notification_only' && notificationOf) {
    return sendEmail({
      to: inviteeEmail,
      subject: '🔐 New admin account created on Panalo.ai',
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:0 auto;background:#faf9f6;border-radius:12px;overflow:hidden">
          <div style="background:linear-gradient(135deg,#b45309,#7c2d12);padding:20px 28px;color:white">
            <div style="font-size:13px;opacity:.9;letter-spacing:.5px">🔐 SECURITY NOTIFICATION</div>
            <h2 style="margin:6px 0 0;font-size:18px;color:white">New admin account created</h2>
          </div>
          <div style="padding:22px 28px;color:#2a2520;font-size:14px;line-height:1.6">
            <p style="margin:0 0 12px">A new admin account was just created on Panalo.ai:</p>
            <div style="background:white;border:1px solid #e2ddd8;border-radius:8px;padding:12px 16px;margin:14px 0;font-size:13px">
              <div><strong>Name:</strong> ${esc(notificationOf.first_name)} ${esc(notificationOf.last_name)}</div>
              <div><strong>Email:</strong> ${esc(notificationOf.email)}</div>
              <div><strong>Created by:</strong> ${esc(inviterName)}</div>
            </div>
            <p style="margin:12px 0;font-size:13px;color:#9b948e">
              If you did NOT expect this — disable the account immediately in Supabase
              <code>UPDATE users SET role='client' WHERE email='${esc(notificationOf.email)}';</code>
            </p>
          </div>
        </div>`,
      text:
        `Security notification — A new admin account was created on Panalo.ai:\n\n` +
        `Name: ${notificationOf.first_name} ${notificationOf.last_name}\n` +
        `Email: ${notificationOf.email}\n` +
        `Created by: ${inviterName}\n\n` +
        `If you did NOT expect this, disable the account immediately.`,
    });
  }

  // Real invite to a new agent or admin
  const setupUrl = `${baseUrl}/set-password.html?token=${encodeURIComponent(token)}`;
  const roleLabel = role === 'admin' ? 'Admin' : 'Agent';
  const intro = isResend
    ? `Here\'s a fresh invitation link to set your Panalo.ai ${roleLabel} password.`
    : `${esc(inviterName)} has invited you to join the Panalo.ai team as ${role === 'admin' ? 'an Admin' : 'an Agent'}.`;

  return sendEmail({
    to: inviteeEmail,
    subject: isResend
      ? `Your Panalo.ai invitation (resent)`
      : `You're invited to join Panalo.ai as ${roleLabel.toLowerCase()}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:0 auto;background:#faf9f6;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#0f8c7e,#1a1a26);padding:24px 28px;color:white">
          <div style="font-size:13px;opacity:.85;letter-spacing:.5px">PANALO.AI</div>
          <h2 style="margin:6px 0 0;font-size:22px;color:white">Welcome to the team 🤝</h2>
        </div>
        <div style="padding:24px 28px;color:#2a2520;font-size:15px;line-height:1.6">
          <p style="margin:0 0 14px">Hi ${esc(inviteeName)},</p>
          <p style="margin:0 0 14px">${intro}</p>
          <p style="margin:0 0 14px">Click the button below to set your password and activate your account:</p>
          <div style="text-align:center;margin:22px 0 8px">
            <a href="${setupUrl}" style="display:inline-block;background:#0f8c7e;color:white;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:.2px">
              🔑 Set your password →
            </a>
          </div>
          <p style="font-size:12px;color:#9b948e;text-align:center;margin:8px 0 0">
            This link expires in 7 days. If it expires, ask your admin to resend.
          </p>
          <p style="margin:18px 0 0;font-size:13px;color:#6b6560">
            Your sign-in email will be: <strong>${esc(inviteeEmail)}</strong>
          </p>
          <p style="margin:14px 0 0;font-size:12px;color:#9b948e">
            If you weren't expecting this email, you can ignore it — no account will be activated.
          </p>
        </div>
      </div>`,
    text:
      `Hi ${inviteeName},\n\n${intro}\n\n` +
      `Set your password and activate your account:\n${setupUrl}\n\n` +
      `Your sign-in email: ${inviteeEmail}\n\n` +
      `This link expires in 7 days. If you weren't expecting this email, ignore it.`,
  });
}

/* ============================================================
   APPEND THIS TO YOUR EXISTING backend/src/lib/email.js
   (Or merge if you've reorganized — the only NEW export is
    sendChatNotificationEmail; the rest is unchanged.)
============================================================ */

/* sendChatNotificationEmail — used by the message notifier worker.
   Sends ONE email summarizing all unread chat messages on a task for a
   given recipient (client OR agent). Uses the same Resend transport as
   your other emails. */
export async function sendChatNotificationEmail({
  recipient,
  recipientRole,        // 'client' | 'agent'
  task,
  messages,             // array of message rows
}) {
  if (!recipient?.email) {
    throw new Error('sendChatNotificationEmail: recipient missing email');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return; // nothing to send
  }

  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.panalo.ai';

  /* Where the recipient lands when they click the email — direct to their
     dashboard. The task ID is appended so the frontend can auto-open the
     task panel. */
  const dashboardPath = recipientRole === 'agent' ? 'agent.html' : 'dashboard.html';
  const ctaUrl = `${FRONTEND_URL}/${dashboardPath}?task=${encodeURIComponent(task.id)}`;

  const recipientName =
    `${recipient.first_name || ''} ${recipient.last_name || ''}`.trim() ||
    recipient.email.split('@')[0];

  const taskTitle = (task.title || 'your task').slice(0, 120);
  const isMultiple = messages.length > 1;

  /* Sender summary — "Janelle Saulog" or "Janelle and 1 other".
     Pulls sender_name straight off the message rows so we don't have to
     re-query for user names. */
  const senderNames = [...new Set(messages.map(m => m.sender_name).filter(Boolean))];
  const senderLabel = senderNames.length === 0
    ? (recipientRole === 'client' ? 'Your Panalo agent' : 'Your client')
    : senderNames.length === 1
      ? senderNames[0]
      : `${senderNames[0]} and ${senderNames.length - 1} other${senderNames.length > 2 ? 's' : ''}`;

  const subject = isMultiple
    ? `${messages.length} new messages from ${senderLabel} — "${taskTitle}"`
    : `New message from ${senderLabel} — "${taskTitle}"`;

  /* Build HTML body — keep it simple, plain, no fancy fonts or imagery so
     it renders cleanly in Gmail/Outlook/dark mode. */
  const messagesHtml = messages.slice(0, 5).map(m => {
    const body = String(m.body || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .slice(0, 400);
    const sender = m.sender_name || (m.sender_type === 'client' ? 'Client' : 'Agent');
    const time = m.created_at
      ? new Date(m.created_at).toLocaleString('en-US', {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        })
      : '';
    return `
      <div style="border-left: 3px solid #00d4aa; padding: 8px 12px; margin-bottom: 12px; background: #f7f9fa;">
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">
          <strong>${sender}</strong>${time ? ` · ${time}` : ''}
        </div>
        <div style="font-size: 14px; color: #1f2937; line-height: 1.5; white-space: pre-wrap;">${body}</div>
      </div>`;
  }).join('');

  const moreNote = messages.length > 5
    ? `<div style="font-size: 12px; color: #6b7280; margin-bottom: 16px;">
         ...and ${messages.length - 5} more message${messages.length - 5 === 1 ? '' : 's'}.
       </div>`
    : '';

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:32px 12px;">
        <tr><td align="center">
          <table width="560" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:10px;border:1px solid #e5e7eb;">
            <tr><td style="padding: 32px 36px 16px 36px;">
              <div style="font-size: 20px; font-weight: 700; color: #111827;">
                Panalo<span style="color:#00d4aa;">.ai</span>
              </div>
            </td></tr>
            <tr><td style="padding: 0 36px 16px 36px;">
              <h1 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 600; color: #111827;">
                Hi ${recipientName.split(' ')[0]},
              </h1>
              <p style="margin: 0; font-size: 15px; line-height: 1.55; color: #374151;">
                You have ${isMultiple ? `<strong>${messages.length} new messages</strong>` : 'a new message'}
                on your task <strong>&ldquo;${taskTitle}&rdquo;</strong>.
              </p>
            </td></tr>
            <tr><td style="padding: 16px 36px 8px 36px;">
              ${messagesHtml}
              ${moreNote}
            </td></tr>
            <tr><td align="center" style="padding: 8px 36px 28px 36px;">
              <a href="${ctaUrl}"
                 style="display: inline-block; background: #00d4aa; color: #07070c; text-decoration: none; font-weight: 600; padding: 12px 28px; border-radius: 8px; font-size: 14px;">
                View and reply →
              </a>
            </td></tr>
            <tr><td style="padding: 0 36px 28px 36px; border-top: 1px solid #e5e7eb; padding-top: 16px;">
              <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #6b7280;">
                You're receiving this because you have unread messages on a task you submitted on Panalo.ai.
                Reply directly in the dashboard.
              </p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>`;

  const text = [
    `Hi ${recipientName.split(' ')[0]},`,
    '',
    isMultiple
      ? `You have ${messages.length} new messages on your task "${taskTitle}".`
      : `You have a new message from ${senderLabel} on your task "${taskTitle}".`,
    '',
    ...messages.slice(0, 5).map(m => {
      const sender = m.sender_name || (m.sender_type === 'client' ? 'Client' : 'Agent');
      return `--- ${sender} ---\n${(m.body || '').slice(0, 400)}\n`;
    }),
    messages.length > 5 ? `(and ${messages.length - 5} more)\n` : '',
    `View and reply: ${ctaUrl}`,
    '',
    `— Panalo.ai`,
  ].join('\n');

  /* Send via the existing sendEmail() helper at the top of this file.
     It already handles the Resend REST API call, dev-mode skipping, error
     logging, and from-address defaults. */
  await sendEmail({
    to: recipient.email,
    subject,
    html,
    text,
  });
}