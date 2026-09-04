import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { requireAuth } from "@/lib/admin/require-auth";
import { createClient } from "@/lib/supabase/server";
import { decrypt, isEncryptionConfigured } from "@/lib/email/crypto";
import { rowToAccount, type EmailAccountRow } from "@/lib/email/types";
import { buildSmtpTestEmail } from "@/lib/email/templates/smtp-test";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  if (!isEncryptionConfigured()) {
    return NextResponse.json(
      { error: "SMTP_ENCRYPTION_KEY is not configured" },
      { status: 400 },
    );
  }

  let body: { accountId: string; recipientEmail: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.accountId || !body.recipientEmail) {
    return NextResponse.json(
      { error: "accountId and recipientEmail are required" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("email_accounts")
    .select("*")
    .eq("id", body.accountId)
    .single();

  if (error || !row) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  const account = rowToAccount(row as EmailAccountRow);

  let password: string;
  try {
    password = decrypt(account.encryptedPassword);
  } catch {
    return NextResponse.json(
      {
        error:
          "Failed to decrypt account password. Check your SMTP_ENCRYPTION_KEY.",
      },
      { status: 500 },
    );
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

  try {
    await transport.verify();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return NextResponse.json(
      { error: `SMTP connection failed: ${message}` },
      { status: 400 },
    );
  }

  try {
    const email = buildSmtpTestEmail({
      label: account.label,
      host: account.host,
      port: account.port,
      fromEmail: account.fromEmail,
      sentAt: new Date().toISOString(),
    });

    const info = await transport.sendMail({
      from: `"${account.fromName}" <${account.fromEmail}>`,
      replyTo: account.replyTo || undefined,
      to: body.recipientEmail,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });

    return NextResponse.json({
      success: true,
      messageId: info.messageId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send test email";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
