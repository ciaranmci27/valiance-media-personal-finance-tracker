import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { requireAuth } from "@/lib/admin/require-auth";
import { createClient } from "@/lib/supabase/server";
import { encrypt, decrypt, isEncryptionConfigured } from "@/lib/email/crypto";
import {
  rowToAccount,
  type EmailAccount,
  type EmailAccountRow,
  type EmailAccountSafe,
} from "@/lib/email/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toSafe(account: EmailAccount): EmailAccountSafe {
  return {
    id: account.id,
    label: account.label,
    host: account.host,
    port: account.port,
    secure: account.secure,
    username: account.username,
    hasPassword: !!account.encryptedPassword,
    fromName: account.fromName,
    fromEmail: account.fromEmail,
    replyTo: account.replyTo,
    isDefault: account.isDefault,
    createdAt: account.createdAt,
  };
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  if (!isEncryptionConfigured()) {
    return NextResponse.json(
      { error: "SMTP_ENCRYPTION_KEY is not configured" },
      { status: 400 },
    );
  }

  const { id } = await params;

  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: existingRow, error: fetchError } = await supabase
    .from("email_accounts")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !existingRow) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  const existing = rowToAccount(existingRow as EmailAccountRow);

  const requiredStrings = ["label", "host", "username", "fromName", "fromEmail"] as const;
  for (const field of requiredStrings) {
    if (typeof input[field] === "string" && !(input[field] as string).trim()) {
      return NextResponse.json({ error: `${field} cannot be empty` }, { status: 400 });
    }
  }

  if (typeof input.label === "string") existing.label = input.label;
  if (typeof input.host === "string") existing.host = input.host;
  if (typeof input.port === "number") existing.port = input.port;
  if (typeof input.secure === "boolean") existing.secure = input.secure;
  if (typeof input.username === "string") existing.username = input.username;
  if (typeof input.fromName === "string") existing.fromName = input.fromName;
  if (typeof input.fromEmail === "string") existing.fromEmail = input.fromEmail;
  if (typeof input.replyTo === "string") existing.replyTo = input.replyTo || undefined;

  const { data: others, error: othersError } = await supabase
    .from("email_accounts")
    .select("id, username, host, is_default")
    .neq("id", id);
  if (othersError) {
    return NextResponse.json({ error: othersError.message }, { status: 500 });
  }

  const duplicate = (others ?? []).find(
    (a) =>
      a.username.toLowerCase() === existing.username.toLowerCase() &&
      a.host.toLowerCase() === existing.host.toLowerCase(),
  );
  if (duplicate) {
    return NextResponse.json(
      {
        error: `An account with username "${existing.username}" on host "${existing.host}" already exists`,
      },
      { status: 409 },
    );
  }

  const passwordChanged =
    typeof input.password === "string" && (input.password as string).length > 0;
  if (passwordChanged) {
    existing.encryptedPassword = encrypt(input.password as string);
  }

  const connectionChanged =
    input.host !== undefined ||
    input.port !== undefined ||
    input.secure !== undefined ||
    input.username !== undefined ||
    passwordChanged;

  if (connectionChanged) {
    let password: string;
    try {
      password = passwordChanged
        ? (input.password as string)
        : decrypt(existing.encryptedPassword);
    } catch {
      return NextResponse.json(
        {
          error: "Failed to decrypt existing password. Check your SMTP_ENCRYPTION_KEY.",
        },
        { status: 500 },
      );
    }

    const transport = nodemailer.createTransport({
      host: existing.host,
      port: existing.port,
      secure: existing.secure,
      auth: { user: existing.username, pass: password },
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
  }

  let nextIsDefault = existing.isDefault;
  if (input.isDefault === true) {
    nextIsDefault = true;
  } else if (input.isDefault === false && existing.isDefault) {
    const otherDefault = (others ?? []).some((a) => a.is_default);
    nextIsDefault = !otherDefault; // stays default if it's the only one
  }

  // If promoting this to default, unset any other default first
  if (nextIsDefault && !existing.isDefault) {
    const { error: unsetError } = await supabase
      .from("email_accounts")
      .update({ is_default: false })
      .eq("is_default", true);
    if (unsetError) {
      return NextResponse.json({ error: unsetError.message }, { status: 500 });
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from("email_accounts")
    .update({
      label: existing.label,
      host: existing.host,
      port: existing.port,
      secure: existing.secure,
      username: existing.username,
      encrypted_password: existing.encryptedPassword,
      from_name: existing.fromName,
      from_email: existing.fromEmail,
      reply_to: existing.replyTo ?? null,
      is_default: nextIsDefault,
    })
    .eq("id", id)
    .select("*")
    .single();

  if (updateError || !updated) {
    return NextResponse.json(
      { error: updateError?.message ?? "Failed to update account" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    account: toSafe(rowToAccount(updated as EmailAccountRow)),
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await params;

  const supabase = await createClient();

  const { data: toDelete, error: fetchError } = await supabase
    .from("email_accounts")
    .select("id, is_default")
    .eq("id", id)
    .single();

  if (fetchError || !toDelete) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const { error: deleteError } = await supabase
    .from("email_accounts")
    .delete()
    .eq("id", id);
  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  // If we removed the default, promote the oldest remaining account
  if (toDelete.is_default) {
    const { data: remaining } = await supabase
      .from("email_accounts")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1);
    if (remaining && remaining.length > 0) {
      await supabase
        .from("email_accounts")
        .update({ is_default: true })
        .eq("id", remaining[0].id);
    }
  }

  return NextResponse.json({ success: true });
}
