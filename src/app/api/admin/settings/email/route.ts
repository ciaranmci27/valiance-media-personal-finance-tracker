import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { requireAuth } from "@/lib/admin/require-auth";
import { createClient } from "@/lib/supabase/server";
import { encrypt, isEncryptionConfigured } from "@/lib/email/crypto";
import {
  rowToAccount,
  type EmailAccountInput,
  type EmailAccountRow,
  type EmailAccountSafe,
} from "@/lib/email/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toSafe(row: EmailAccountRow): EmailAccountSafe {
  const a = rowToAccount(row);
  return {
    id: a.id,
    label: a.label,
    host: a.host,
    port: a.port,
    secure: a.secure,
    username: a.username,
    hasPassword: !!a.encryptedPassword,
    fromName: a.fromName,
    fromEmail: a.fromEmail,
    replyTo: a.replyTo,
    isDefault: a.isDefault,
    createdAt: a.createdAt,
  };
}

export async function GET() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("email_accounts")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    accounts: (data as EmailAccountRow[]).map(toSafe),
    encryptionConfigured: isEncryptionConfigured(),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  if (!isEncryptionConfigured()) {
    return NextResponse.json(
      { error: "SMTP_ENCRYPTION_KEY is not configured" },
      { status: 400 },
    );
  }

  let input: EmailAccountInput;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !input.label ||
    !input.host ||
    !input.port ||
    !input.username ||
    !input.password ||
    !input.fromName ||
    !input.fromEmail
  ) {
    return NextResponse.json(
      {
        error:
          "Missing required fields: label, host, port, username, password, fromName, fromEmail",
      },
      { status: 400 },
    );
  }

  const supabase = await createClient();

  const { data: existing, error: listError } = await supabase
    .from("email_accounts")
    .select("id, username, host");
  if (listError) {
    return NextResponse.json({ error: listError.message }, { status: 500 });
  }
  const duplicate = (existing ?? []).find(
    (a) =>
      a.username.toLowerCase() === input.username.toLowerCase() &&
      a.host.toLowerCase() === input.host.toLowerCase(),
  );
  if (duplicate) {
    return NextResponse.json(
      {
        error: `An account with username "${input.username}" on host "${input.host}" already exists`,
      },
      { status: 409 },
    );
  }

  // Verify SMTP connection before saving
  const transport = nodemailer.createTransport({
    host: input.host,
    port: input.port,
    secure: input.secure ?? input.port === 465,
    auth: { user: input.username, pass: input.password },
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

  const firstAccount = (existing ?? []).length === 0;
  const shouldBeDefault = firstAccount || !!input.isDefault;

  // If setting as default, unset any existing default first
  if (shouldBeDefault && !firstAccount) {
    const { error: unsetError } = await supabase
      .from("email_accounts")
      .update({ is_default: false })
      .eq("is_default", true);
    if (unsetError) {
      return NextResponse.json({ error: unsetError.message }, { status: 500 });
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from("email_accounts")
    .insert({
      label: input.label,
      host: input.host,
      port: input.port,
      secure: input.secure ?? input.port === 465,
      username: input.username,
      encrypted_password: encrypt(input.password),
      from_name: input.fromName,
      from_email: input.fromEmail,
      reply_to: input.replyTo || null,
      is_default: shouldBeDefault,
    })
    .select("*")
    .single();

  if (insertError || !inserted) {
    return NextResponse.json(
      { error: insertError?.message ?? "Failed to create account" },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { account: toSafe(inserted as EmailAccountRow) },
    { status: 201 },
  );
}
