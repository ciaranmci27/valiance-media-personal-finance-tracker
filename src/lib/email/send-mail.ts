import nodemailer from 'nodemailer';
import { createClient } from '@/lib/supabase/server';
import { decrypt } from './crypto';
import { rowToAccount, type EmailAccount, type EmailAccountRow } from './types';

// ─── Shared ───────────────────────────────────────────────────────────────────

interface SendMailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

async function loadAccount(accountId?: string): Promise<EmailAccount | null> {
  const supabase = await createClient();

  if (accountId) {
    const { data, error } = await supabase
      .from('email_accounts')
      .select('*')
      .eq('id', accountId)
      .single();
    if (error || !data) return null;
    return rowToAccount(data as EmailAccountRow);
  }

  const { data: defaultRow } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('is_default', true)
    .maybeSingle();
  if (defaultRow) return rowToAccount(defaultRow as EmailAccountRow);

  const { data: fallback } = await supabase
    .from('email_accounts')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return fallback ? rowToAccount(fallback as EmailAccountRow) : null;
}

async function getAccountAndTransport(accountId?: string) {
  const account = await loadAccount(accountId);

  if (!account) {
    return { error: accountId ? 'Email account not found' : 'No email accounts configured' } as const;
  }

  let password: string;
  try {
    password = decrypt(account.encryptedPassword);
  } catch {
    return { error: 'Failed to decrypt email account password' } as const;
  }

  const transport = nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: {
      user: account.username,
      pass: password,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });

  return { account, transport } as const;
}

// ─── Transactional ────────────────────────────────────────────────────────────
// App to user: confirmations, receipts, password resets, notifications.
// Uses the account's configured From identity and Reply-To.
//
// Example:
//   await sendTransactional({
//     to: user.email,
//     subject: 'Your order has been confirmed',
//     html: orderConfirmationHtml,
//   });

interface TransactionalOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  accountId?: string;
}

export async function sendTransactional(options: TransactionalOptions): Promise<SendMailResult> {
  const recipients = Array.isArray(options.to) ? options.to.filter(Boolean) : [options.to].filter(Boolean);
  if (recipients.length === 0) {
    console.error('[sendTransactional] No recipient address provided -- set the "to" field in your API route');
    return { success: false, error: 'No recipient address provided -- set the "to" field in your API route' };
  }

  const result = await getAccountAndTransport(options.accountId);
  if ('error' in result) return { success: false, error: result.error };

  const { account, transport } = result;

  try {
    const info = await transport.sendMail({
      from: `"${account.fromName}" <${account.fromEmail}>`,
      replyTo: account.replyTo || undefined,
      to: recipients.join(', '),
      subject: options.subject.replace(/[\r\n]/g, '').trim(),
      html: options.html,
      text: options.text,
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error sending email';
    return { success: false, error: message };
  }
}

// ─── Relay ────────────────────────────────────────────────────────────────────
// Form submitter to your team: contact forms, support requests, inquiries.
// From name shows the submitter, From email stays as account's domain (for SPF/DKIM).
// Reply-To is set to the submitter so your team can reply directly.
//
// Example:
//   await sendRelay({
//     to: 'team@yourdomain.com',
//     subject: `New inquiry from ${formData.name}`,
//     html: contactFormHtml,
//     sender: { name: 'John Doe', email: 'john@gmail.com' },
//   });

interface RelayOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  sender: { name: string; email: string };
  accountId?: string;
}

export async function sendRelay(options: RelayOptions): Promise<SendMailResult> {
  const recipients = Array.isArray(options.to) ? options.to.filter(Boolean) : [options.to].filter(Boolean);
  if (recipients.length === 0) {
    console.error('[sendRelay] No recipient address provided -- set the "to" field in your API route');
    return { success: false, error: 'No recipient address provided -- set the "to" field in your API route' };
  }

  const result = await getAccountAndTransport(options.accountId);
  if ('error' in result) return { success: false, error: result.error };

  const { account, transport } = result;

  // Sanitize sender input to prevent email header injection
  const safeName = options.sender.name.replace(/[\r\n"]/g, '').trim();
  const safeEmail = options.sender.email.replace(/[\r\n,;]/g, '').trim();
  const safeSubject = options.subject.replace(/[\r\n]/g, '').trim();

  // Basic email format validation
  if (safeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
    return { success: false, error: 'Invalid sender email address format' };
  }

  try {
    const info = await transport.sendMail({
      from: `"${safeName}" <${account.fromEmail}>`,
      replyTo: safeEmail || undefined,
      to: recipients.join(', '),
      subject: safeSubject,
      html: options.html,
      text: options.text,
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error sending email';
    return { success: false, error: message };
  }
}
