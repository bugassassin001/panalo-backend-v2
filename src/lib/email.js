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

export async function sendTaskCompletedEmail(user, task, result) {
  const subject = result.handler === 'ai'
    ? `⚡ Task completed by AI — ${task.title.slice(0, 50)}`
    : `✓ Task completed by your agent — ${task.title.slice(0, 50)}`;
  return sendEmail({
    to: user.email, subject,
    html: `<p>${esc(task.title)} — completed.</p>`,
    text: `Your task "${task.title}" has been completed.`,
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
