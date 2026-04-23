import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { requireAuth } from "@/lib/admin/require-auth";
import { createClient } from "@/lib/supabase/server";
import { decrypt, isEncryptionConfigured } from "@/lib/email/crypto";
import { rowToAccount, type EmailAccountRow } from "@/lib/email/types";

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

  let body: { accountId: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
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
    return NextResponse.json({
      online: false,
      reason: "decrypt_failed",
      error: "Failed to decrypt password. Check your SMTP_ENCRYPTION_KEY",
    });
  }

  const transport = nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.username, pass: password },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });

  try {
    await transport.verify();
    return NextResponse.json({ online: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return NextResponse.json({
      online: false,
      reason: "connection_failed",
      error: message,
    });
  }
}
