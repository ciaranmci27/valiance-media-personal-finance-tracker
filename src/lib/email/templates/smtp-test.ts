/**
 * The message the email settings page sends to prove an SMTP account can
 * deliver mail. Whoever receives it should see which account it came from
 * and when, nothing more.
 */

import {
  emailLayout,
  escapeHtml,
  footerLine,
  footerLink,
  getSiteName,
  getSiteUrl,
  heading,
  kvRows,
  metaLine,
  paragraph,
} from './shared';

export interface SmtpTestEmailParams {
  label: string;
  host: string;
  port: number;
  fromEmail: string;
  /** ISO timestamp of the send. */
  sentAt: string;
}

export function buildSmtpTestEmail(params: SmtpTestEmailParams): { subject: string; html: string; text: string } {
  const { label, host, port, fromEmail, sentAt } = params;
  const siteUrl = getSiteUrl();
  const name = getSiteName();

  const body = [
    heading('SMTP is', 'working.'),
    metaLine([sentAt]),
    paragraph(
      `This is a test from the admin panel. If you are reading it, the account <strong>${escapeHtml(label)}</strong> is configured correctly and can deliver mail.`,
    ),
    kvRows([
      { label: 'Account', value: label },
      { label: 'Host', value: host },
      { label: 'Port', value: String(port) },
      { label: 'From', value: fromEmail },
    ]),
  ].join('');

  const footerHtml = `
    ${footerLine('Sent from the email settings page to confirm this account can deliver mail.')}
    ${footerLine(`&copy; ${new Date().getFullYear()} ${footerLink(siteUrl, name)}`)}`;

  const html = emailLayout({
    preheader: `The SMTP account "${label}" delivered this test.`,
    body,
    footerHtml,
  });

  const text = [
    'SMTP is working.',
    '',
    `This is a test from the admin panel. If you are reading it, the account "${label}" is configured correctly and can deliver mail.`,
    '',
    `Account: ${label}`,
    `Host: ${host}`,
    `Port: ${port}`,
    `From: ${fromEmail}`,
    `Sent at: ${sentAt}`,
  ].join('\n');

  return { subject: 'Test email: SMTP configuration', html, text };
}
