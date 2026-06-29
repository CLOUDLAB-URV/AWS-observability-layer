'use strict';

// Email delivery for verification codes. Uses SMTP via nodemailer when configured, otherwise
// falls back to a "dev" mode that just logs the code (so local development works with no mail
// server). Config (env):
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, MAIL_FROM
// SMTP is considered configured when HOST + USER + PASS are all set.

import process from 'node:process';

export function smtpConfigured() {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transportPromise = null;
async function getTransport() {
    if (!transportPromise) {
        transportPromise = import('nodemailer').then(({ default: nodemailer }) => {
            const port = Number.parseInt(process.env.SMTP_PORT ?? '587', 10) || 587;
            return nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port,
                secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
                auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            });
        });
    }
    return transportPromise;
}

function mailFrom() {
    return process.env.MAIL_FROM || process.env.SMTP_USER || 'AWS Architect <no-reply@localhost>';
}

function renderText(code, username) {
    return [
        `Hi ${username || 'there'},`,
        '',
        'Your AWS Architect verification code is:',
        '',
        `    ${code}`,
        '',
        'It expires in 10 minutes. If you didn\'t request this, you can ignore this email.'
    ].join('\n');
}

// Wrap body rows in the shared, self-contained card shell (email clients ignore external CSS).
function shell(rows) {
    return `<!doctype html><html><body style="margin:0;background:#f4f4f5;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" style="max-width:440px;background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;overflow:hidden;">
      <tr><td style="padding:28px 32px 8px;font-size:18px;font-weight:700;letter-spacing:-0.01em;">AWS Architect</td></tr>
      ${rows}
    </table>
  </td></tr></table>
</body></html>`;
}

function renderHtml(code, username) {
    return shell(`
      <tr><td style="padding:0 32px;color:#52525b;font-size:14px;line-height:1.6;">
        Hi ${username || 'there'}, use this code to verify your email and finish creating your account:
      </td></tr>
      <tr><td align="center" style="padding:24px 32px;">
        <div style="display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#18181b;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:10px;padding:14px 22px;">${code}</div>
      </td></tr>
      <tr><td style="padding:0 32px 28px;color:#a1a1aa;font-size:12px;line-height:1.6;">
        This code expires in 10 minutes. If you didn't request it, you can safely ignore this email.
      </td></tr>`);
}

function renderResetText(resetUrl, username) {
    return [
        `Hi ${username || 'there'},`,
        '',
        'We received a request to reset your AWS Architect password. Open this link to choose a new one:',
        '',
        `    ${resetUrl}`,
        '',
        'The link expires in 30 minutes. If you didn\'t request this, you can ignore this email — your password won\'t change.'
    ].join('\n');
}

function renderResetHtml(resetUrl, username) {
    return shell(`
      <tr><td style="padding:0 32px;color:#52525b;font-size:14px;line-height:1.6;">
        Hi ${username || 'there'}, we received a request to reset your password. Click the button below to choose a new one:
      </td></tr>
      <tr><td align="center" style="padding:24px 32px;">
        <a href="${resetUrl}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;border-radius:10px;padding:13px 26px;">Reset password</a>
      </td></tr>
      <tr><td style="padding:0 32px;color:#a1a1aa;font-size:12px;line-height:1.6;word-break:break-all;">
        Or paste this link into your browser:<br><span style="color:#52525b;">${resetUrl}</span>
      </td></tr>
      <tr><td style="padding:16px 32px 28px;color:#a1a1aa;font-size:12px;line-height:1.6;">
        This link expires in 30 minutes. If you didn't request it, you can safely ignore this email — your password won't change.
      </td></tr>`);
}

// Send (or dev-log) a verification code. Returns { dev:true } when no SMTP is configured,
// or { sent:true } after a successful send. Throws if SMTP is configured but sending fails.
export async function sendVerificationCode(email, code, username) {
    if (!smtpConfigured()) {
        console.log(`[mailer:dev] verification code for ${email}: ${code}`);
        return { dev: true };
    }
    const transport = await getTransport();
    await transport.sendMail({
        from: mailFrom(),
        to: email,
        subject: 'Your AWS Architect verification code',
        text: renderText(code, username),
        html: renderHtml(code, username)
    });
    return { sent: true };
}

// Send (or dev-log) a password-reset link. Returns { dev:true } when no SMTP is configured,
// or { sent:true } after a successful send. Throws if SMTP is configured but sending fails.
export async function sendPasswordReset(email, resetUrl, username) {
    if (!smtpConfigured()) {
        console.log(`[mailer:dev] password reset link for ${email}: ${resetUrl}`);
        return { dev: true };
    }
    const transport = await getTransport();
    await transport.sendMail({
        from: mailFrom(),
        to: email,
        subject: 'Reset your AWS Architect password',
        text: renderResetText(resetUrl, username),
        html: renderResetHtml(resetUrl, username)
    });
    return { sent: true };
}
