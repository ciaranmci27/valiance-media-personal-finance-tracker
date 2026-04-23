export interface EmailAccount {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  encryptedPassword: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  isDefault: boolean;
  createdAt: string;
}

export interface EmailAccountInput {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  isDefault: boolean;
}

export interface EmailAccountSafe {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  hasPassword: boolean;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  isDefault: boolean;
  createdAt: string;
}

export interface EmailAccountRow {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  encrypted_password: string;
  from_name: string;
  from_email: string;
  reply_to: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export function rowToAccount(row: EmailAccountRow): EmailAccount {
  return {
    id: row.id,
    label: row.label,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    encryptedPassword: row.encrypted_password,
    fromName: row.from_name,
    fromEmail: row.from_email,
    replyTo: row.reply_to ?? undefined,
    isDefault: row.is_default,
    createdAt: row.created_at,
  };
}
