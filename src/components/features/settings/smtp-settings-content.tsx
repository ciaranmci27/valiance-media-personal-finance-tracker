"use client";

import * as React from "react";
import {
  ArrowLeftCircle,
  Check,
  Copy,
  KeyRound,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { CustomSelect } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface EmailAccountSafe {
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

interface FormData {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  isDefault: boolean;
}

const emptyForm: FormData = {
  label: "",
  host: "",
  port: 465,
  secure: true,
  username: "",
  password: "",
  fromName: "",
  fromEmail: "",
  replyTo: "",
  isDefault: false,
};

type AccountStatusType = "checking" | "online" | "offline" | "key_error";

function StatusDot({ status }: { status: AccountStatusType }) {
  const config = {
    online: { color: "bg-success", label: "Online", pulse: "animate-pulse" },
    offline: { color: "bg-error", label: "Offline", pulse: "" },
    key_error: { color: "bg-warning", label: "Key Error", pulse: "" },
    checking: { color: "bg-muted-foreground/60", label: "Checking", pulse: "animate-pulse" },
  }[status];

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", config.color, config.pulse)} aria-hidden="true" />
      <span>{config.label}</span>
    </span>
  );
}

interface Props {
  encryptionConfigured: boolean;
}

export function SmtpSettingsContent({ encryptionConfigured }: Props) {
  const [accounts, setAccounts] = React.useState<EmailAccountSafe[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [showForm, setShowForm] = React.useState(false);
  const [form, setForm] = React.useState<FormData>(emptyForm);
  const [saving, setSaving] = React.useState(false);

  const [generatedKey, setGeneratedKey] = React.useState<string | null>(null);
  const [generatingKey, setGeneratingKey] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [testEmail, setTestEmail] = React.useState("");
  const [testSending, setTestSending] = React.useState(false);
  const { confirm: confirmAction, dialog } = useConfirmationDialog();

  const [accountStatus, setAccountStatus] = React.useState<Record<string, AccountStatusType>>({});

  const [keyRecoveryPath, setKeyRecoveryPath] = React.useState<"lost" | "generate" | null>(null);
  const [recoveryKey, setRecoveryKey] = React.useState<string | null>(null);
  const [recoveryCopied, setRecoveryCopied] = React.useState(false);

  const verifyAccounts = React.useCallback((accs: EmailAccountSafe[]) => {
    if (accs.length === 0) return;
    const initial: Record<string, "checking"> = {};
    for (const acc of accs) initial[acc.id] = "checking";
    setAccountStatus(initial);

    for (const acc of accs) {
      fetch("/api/admin/settings/email/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: acc.id }),
      })
        .then((res) => res.json())
        .then((data) => {
          const status: AccountStatusType = data.online
            ? "online"
            : data.reason === "decrypt_failed"
            ? "key_error"
            : "offline";
          setAccountStatus((prev) => ({ ...prev, [acc.id]: status }));
        })
        .catch(() => {
          setAccountStatus((prev) => ({ ...prev, [acc.id]: "offline" }));
        });
    }
  }, []);

  const fetchAccounts = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/settings/email");
      if (res.ok) {
        const data = await res.json();
        const accs = data.accounts ?? [];
        setAccounts(accs);
        verifyAccounts(accs);
      }
    } catch {
      console.error("Failed to fetch email accounts");
    } finally {
      setLoading(false);
    }
  }, [verifyAccounts]);

  React.useEffect(() => {
    if (encryptionConfigured) {
      fetchAccounts();
    } else {
      setLoading(false);
    }
  }, [encryptionConfigured, fetchAccounts]);

  const copyEnvLine = async (key: string, setCopiedState: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(`SMTP_ENCRYPTION_KEY=${key}`);
      setCopiedState(true);
      window.setTimeout(() => setCopiedState(false), 2000);
    } catch {
      toast("error", "Copy failed. Clipboard requires HTTPS");
    }
  };

  const generateKey = async (setter: (v: string | null) => void) => {
    setGeneratingKey(true);
    try {
      const res = await fetch("/api/admin/settings/email/generate-key", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setter(data.key);
      } else {
        toast("error", "Failed to generate key");
      }
    } catch {
      toast("error", "Failed to generate key");
    } finally {
      setGeneratingKey(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    const isEdit = !!editingId;
    const url = isEdit
      ? `/api/admin/settings/email/${editingId}`
      : "/api/admin/settings/email";
    const method = isEdit ? "PUT" : "POST";

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        toast("success", isEdit ? "Account updated" : "Account created");
        setShowForm(false);
        setEditingId(null);
        setForm(emptyForm);
        await fetchAccounts();
      } else {
        const data = await res.json().catch(() => ({}));
        toast("error", data.error || "Failed to save account");
      }
    } catch {
      toast("error", "Failed to save account");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const confirmed = await confirmAction({
      title: "Delete email account",
      description: "This will permanently remove the SMTP account. This action cannot be undone.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/admin/settings/email/${id}`, { method: "DELETE" });
      if (res.ok) {
        toast("success", "Account deleted");
        await fetchAccounts();
      } else {
        toast("error", "Failed to delete account");
      }
    } catch {
      toast("error", "Failed to delete account");
    }
  };

  const handleTest = async (accountId: string) => {
    if (!testEmail) return;
    setTestSending(true);
    try {
      const res = await fetch("/api/admin/settings/email/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, recipientEmail: testEmail }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast("success", `Test email sent to ${testEmail}`);
        setTestingId(null);
        setTestEmail("");
      } else {
        toast("error", data.error || "Failed to send test email");
      }
    } catch {
      toast("error", "Failed to send test email");
    } finally {
      setTestSending(false);
    }
  };

  const startEdit = (account: EmailAccountSafe) => {
    setForm({
      label: account.label,
      host: account.host,
      port: account.port,
      secure: account.secure,
      username: account.username,
      password: "",
      fromName: account.fromName,
      fromEmail: account.fromEmail,
      replyTo: account.replyTo ?? "",
      isDefault: account.isDefault,
    });
    setEditingId(account.id);
    setShowForm(true);
  };

  // ─── Header ──────────────────────────────────────────────────────────────────

  const header = (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/10">
          <Mail className="h-5 w-5 text-sky-500" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">SMTP &amp; Email</h1>
          <p className="text-sm text-muted-foreground">
            Configure outbound email accounts
          </p>
        </div>
      </div>
      {encryptionConfigured && !showForm && accounts.length > 0 && (
        <Button
          size="sm"
          onClick={() => {
            setForm(emptyForm);
            setEditingId(null);
            setShowForm(true);
          }}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add
        </Button>
      )}
    </div>
  );

  // ─── Onboarding (no encryption key) ──────────────────────────────────────────

  if (!encryptionConfigured) {
    return (
      <div className="space-y-4 max-w-2xl mx-auto">
        {header}

        <div className="glass-card rounded-xl p-4 border-warning/30 bg-warning/5">
          <p className="flex items-start gap-2 text-sm text-foreground">
            <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5 text-warning" aria-hidden="true" />
            <span>
              An encryption key is required to securely store SMTP passwords. Generate a
              key below and add it to your environment.
            </span>
          </p>
        </div>

        <div className="glass-card rounded-xl p-6 space-y-5">
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-4">
              Setup encryption key
            </h2>

            <div className="space-y-5">
              <div className="flex gap-3">
                <StepNumber n={1} />
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground mb-2">
                    Generate an encryption key
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => generateKey(setGeneratedKey)}
                    disabled={generatingKey || !!generatedKey}
                  >
                    <KeyRound className="h-4 w-4" aria-hidden="true" />
                    {generatingKey ? "Generating..." : generatedKey ? "Key Generated" : "Generate Key"}
                  </Button>
                </div>
              </div>

              {generatedKey && (
                <div className="flex gap-3">
                  <StepNumber n={2} />
                  <div className="flex-1 space-y-2">
                    <p className="text-sm font-medium text-foreground">
                      Add to your environment
                    </p>
                    <button
                      type="button"
                      onClick={() => copyEnvLine(generatedKey, setCopied)}
                      aria-label={copied ? "Copied" : "Click to copy env line"}
                      className="group relative block w-full cursor-pointer rounded-lg border border-border/60 bg-muted/30 p-3 text-left font-mono text-xs leading-relaxed transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <span className="block whitespace-pre-wrap break-all pr-8">
                        SMTP_ENCRYPTION_KEY={generatedKey}
                      </span>
                      <span className="absolute right-2 top-2 text-muted-foreground group-hover:text-foreground transition-colors">
                        {copied ? (
                          <Check className="h-3.5 w-3.5 text-teal" aria-hidden="true" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                      </span>
                    </button>
                    <p className="text-xs text-muted-foreground">
                      Copy into your{" "}
                      <code className="font-mono">.env.local</code> file, then restart
                      the dev server and refresh this page.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Loading ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4 max-w-2xl mx-auto">
        {header}
        <div className="glass-card rounded-xl p-4 space-y-3">
          <div className="h-4 w-40 rounded bg-muted animate-pulse" />
          <div className="h-3 w-64 rounded bg-muted animate-pulse" />
          <div className="h-3 w-52 rounded bg-muted animate-pulse" />
        </div>
      </div>
    );
  }

  // ─── Empty state ─────────────────────────────────────────────────────────────

  if (accounts.length === 0 && !showForm) {
    return (
      <div className="space-y-4 max-w-2xl mx-auto">
        {header}
        <div className="glass-card rounded-xl p-10 flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-500/10 mb-4">
            <Mail className="h-7 w-7 text-sky-500" aria-hidden="true" />
          </div>
          <h3 className="text-base font-semibold text-foreground mb-1">
            No email accounts configured
          </h3>
          <p className="text-sm text-muted-foreground mb-5 max-w-sm">
            Add an SMTP account to start sending transactional emails from the admin panel.
          </p>
          <Button
            onClick={() => {
              setForm(emptyForm);
              setEditingId(null);
              setShowForm(true);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add Email Account
          </Button>
        </div>
      </div>
    );
  }

  // ─── Main: account list + form ───────────────────────────────────────────────

  const hasKeyError = Object.values(accountStatus).some((s) => s === "key_error");

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {header}

      {hasKeyError && (
        <KeyRecoveryBanner
          path={keyRecoveryPath}
          onPath={setKeyRecoveryPath}
          recoveryKey={recoveryKey}
          onGenerate={() => generateKey(setRecoveryKey)}
          onCopy={() => recoveryKey && copyEnvLine(recoveryKey, setRecoveryCopied)}
          copied={recoveryCopied}
          onReset={() => {
            setKeyRecoveryPath(null);
            setRecoveryKey(null);
            setRecoveryCopied(false);
          }}
        />
      )}

      {showForm && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {editingId ? "Edit Account" : "Add Email Account"}
            </h2>
            <div className="flex-1 h-px bg-border/50" />
          </div>

          <div className="glass-card rounded-xl p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Account Name"
              placeholder="e.g. SiteGround Noreply"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            />
            <Input
              label="Host"
              placeholder="mail.yourdomain.com"
              value={form.host}
              onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
            />
            <Input
              label="Username"
              placeholder="noreply@yourdomain.com"
              value={form.username}
              onChange={(e) => {
                const val = e.target.value;
                setForm((f) => {
                  const updated = { ...f, username: val };
                  if (val.includes("@") && (!f.fromEmail || f.fromEmail === f.username)) {
                    updated.fromEmail = val;
                  }
                  return updated;
                });
              }}
            />
            <Input
              label="Password"
              type="password"
              autoComplete="off"
              placeholder={editingId ? "Leave blank to keep existing" : "SMTP password"}
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
            <Input
              label="From Name"
              placeholder="Your Company"
              value={form.fromName}
              onChange={(e) => setForm((f) => ({ ...f, fromName: e.target.value }))}
            />
            <Input
              label="From Email"
              type="email"
              placeholder="noreply@yourdomain.com"
              value={form.fromEmail}
              onChange={(e) => setForm((f) => ({ ...f, fromEmail: e.target.value }))}
            />
            <div className="space-y-2">
              <CustomSelect
                label="Port"
                options={[
                  { value: "465", label: "465 (SSL)" },
                  { value: "587", label: "587 (STARTTLS)" },
                  { value: "custom", label: "Custom" },
                ]}
                value={
                  form.port === 465 ? "465" : form.port === 587 ? "587" : "custom"
                }
                onChange={(val) => {
                  if (val === "custom") {
                    setForm((f) => ({ ...f, port: 0, secure: false }));
                  } else {
                    const port = parseInt(val, 10);
                    setForm((f) => ({ ...f, port, secure: port === 465 }));
                  }
                }}
              />
              {form.port !== 465 && form.port !== 587 && (
                <NumberInput
                  integer
                  placeholder="Custom port"
                  value={String(form.port || "")}
                  onChange={(e) => {
                    const port = parseInt(e.target.value, 10) || 0;
                    setForm((f) => ({ ...f, port, secure: false }));
                  }}
                />
              )}
            </div>
            <Input
              label="Reply-To"
              type="email"
              placeholder="hello@yourdomain.com (optional)"
              value={form.replyTo}
              onChange={(e) => setForm((f) => ({ ...f, replyTo: e.target.value }))}
            />
          </div>

          {(accounts.length > 0 || editingId) && (
            <Switch
              checked={form.isDefault}
              onChange={(checked) => setForm((f) => ({ ...f, isDefault: checked }))}
              label="Primary account"
            />
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-border/50">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : editingId ? "Update account" : "Create account"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setShowForm(false);
                setEditingId(null);
                setForm(emptyForm);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
          </div>
        </div>
      )}

      {!showForm && accounts.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Accounts
            </h2>
            <div className="flex-1 h-px bg-border/50" />
          </div>

          <div className="space-y-2">
          {[...accounts]
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((account) => (
              <div key={account.id} className="glass-card rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-sky-500/10 shrink-0">
                    <Mail className="h-5 w-5 text-sky-500" aria-hidden="true" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-medium text-foreground truncate">
                        {account.label}
                      </h3>
                      {account.isDefault && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider rounded-full px-2 py-0.5 bg-primary/10 text-primary">
                          Primary
                        </span>
                      )}
                      <StatusDot status={accountStatus[account.id] ?? "checking"} />
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {account.fromEmail}
                    </p>
                    <p className="text-xs text-muted-foreground/80 truncate">
                      {account.host}:{account.port} ({account.secure ? "SSL" : "STARTTLS"})
                    </p>
                  </div>
                  {testingId !== account.id && (
                    <div className="flex items-center gap-0.5 shrink-0 -mr-1 -mt-1">
                      <Tooltip content="Send test email">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Send test email"
                          onClick={() => {
                            setTestingId(account.id);
                            setTestEmail("");
                          }}
                        >
                          <Send className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </Tooltip>
                      <Tooltip content="Edit">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Edit account"
                          onClick={() => startEdit(account)}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </Tooltip>
                      <Tooltip content="Delete">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Delete account"
                          className="text-error hover:text-error hover:bg-error/10"
                          onClick={() => handleDelete(account.id)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </Tooltip>
                    </div>
                  )}
                </div>

                {testingId === account.id && (
                  <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/50">
                    <Input
                      type="email"
                      placeholder="Recipient email"
                      value={testEmail}
                      onChange={(e) => setTestEmail(e.target.value)}
                      className="flex-1"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleTest(account.id);
                        if (e.key === "Escape") {
                          setTestingId(null);
                          setTestEmail("");
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      onClick={() => handleTest(account.id)}
                      disabled={testSending || !testEmail}
                    >
                      <Send className="h-3.5 w-3.5" aria-hidden="true" />
                      {testSending ? "Sending..." : "Send"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setTestingId(null);
                        setTestEmail("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {dialog}
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <div
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold"
      aria-hidden="true"
    >
      {n}
    </div>
  );
}

interface KeyRecoveryBannerProps {
  path: "lost" | "generate" | null;
  onPath: (p: "lost" | "generate" | null) => void;
  recoveryKey: string | null;
  onGenerate: () => void;
  onCopy: () => void;
  copied: boolean;
  onReset: () => void;
}

function KeyRecoveryBanner({
  path,
  onPath,
  recoveryKey,
  onGenerate,
  onCopy,
  copied,
  onReset,
}: KeyRecoveryBannerProps) {
  return (
    <div className="glass-card rounded-xl p-4 space-y-4 border-warning/30 bg-warning/5">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-warning/15 shrink-0">
          <KeyRound className="h-4 w-4 text-warning" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">Encryption key issue</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Unable to decrypt account passwords. Your{" "}
            <code className="font-mono rounded bg-muted px-1 py-0.5 text-xs">
              SMTP_ENCRYPTION_KEY
            </code>{" "}
            may have changed or is missing.
          </p>
        </div>
      </div>

      {!path && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onPath("lost")}
            className="glass-card rounded-lg p-3 flex items-start gap-3 text-left hover:border-primary/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 shrink-0">
              <Search className="h-4 w-4 text-primary" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Recover existing key</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Restore your original key from environment variables
              </p>
            </div>
          </button>
          <button
            type="button"
            onClick={() => onPath("generate")}
            className="glass-card rounded-lg p-3 flex items-start gap-3 text-left hover:border-primary/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-warning/15 shrink-0">
              <Sparkles className="h-4 w-4 text-warning" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Generate new key</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Start fresh. Existing accounts must be re-added.
              </p>
            </div>
          </button>
        </div>
      )}

      {path === "lost" && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <StepNumber n={1} />
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground mb-1">Locate your original key</p>
              <p className="text-xs text-muted-foreground">
                Check{" "}
                <code className="font-mono rounded bg-muted px-1 py-0.5 text-xs">.env.local</code>,
                your hosting provider, or deployment settings for{" "}
                <code className="font-mono rounded bg-muted px-1 py-0.5 text-xs">
                  SMTP_ENCRYPTION_KEY
                </code>
                .
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <StepNumber n={2} />
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground mb-1">Restore the key</p>
              <p className="text-xs text-muted-foreground">
                Add it back to your environment, restart your server, then refresh.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-border/50">
            <Button variant="outline" size="sm" onClick={() => onPath(null)}>
              <ArrowLeftCircle className="h-3.5 w-3.5" aria-hidden="true" />
              Back
            </Button>
            <Button variant="outline" size="sm" onClick={() => onPath("generate")}>
              Generate new key instead
            </Button>
          </div>
        </div>
      )}

      {path === "generate" && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <StepNumber n={1} />
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground mb-2">Generate an encryption key</p>
              <Button
                variant="outline"
                size="sm"
                onClick={onGenerate}
                disabled={!!recoveryKey}
              >
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                {recoveryKey ? "Key Generated" : "Generate Key"}
              </Button>
            </div>
          </div>

          {recoveryKey && (
            <>
              <div className="flex gap-3">
                <StepNumber n={2} />
                <div className="flex-1 space-y-2">
                  <p className="text-sm font-medium text-foreground">Add to your environment</p>
                  <button
                    type="button"
                    onClick={onCopy}
                    aria-label={copied ? "Copied" : "Click to copy env line"}
                    className="group relative block w-full cursor-pointer rounded-lg border border-border/60 bg-muted/30 p-3 text-left font-mono text-xs leading-relaxed transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <span className="block whitespace-pre-wrap break-all pr-8">
                      SMTP_ENCRYPTION_KEY={recoveryKey}
                    </span>
                    <span className="absolute right-2 top-2 text-muted-foreground group-hover:text-foreground transition-colors">
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-teal" aria-hidden="true" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                    </span>
                  </button>
                  <p className="text-xs text-muted-foreground">
                    Copy into your{" "}
                    <code className="font-mono">.env.local</code>, restart your server,
                    then refresh.
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <StepNumber n={3} />
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground mb-1">Re-add affected accounts</p>
                  <p className="text-xs text-muted-foreground">
                    Delete accounts showing key errors and re-add them. They&apos;ll be encrypted with your new key.
                  </p>
                </div>
              </div>
            </>
          )}

          <div className="flex items-center pt-2 border-t border-border/50">
            <Button variant="outline" size="sm" onClick={onReset}>
              <ArrowLeftCircle className="h-3.5 w-3.5" aria-hidden="true" />
              Back
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
