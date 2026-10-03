"use client";

import * as React from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Select } from "@/components/ui/inputs/Select";
import { toast } from "@/components/ui/toast";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  API_KEY_LIFETIMES,
  DEFAULT_API_KEY_DAYS,
  type ApiScope,
} from "@/lib/api/scopes";
import type { ApiKey, ApiMember } from "./api-settings-content";
import { ApiScopePicker } from "./api-scope-picker";

interface ApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isOwner: boolean;
  memberId: string;
  members: ApiMember[];
  /** Scopes the signed-in person holds, so a key for themselves can carry them. */
  available: ApiScope[];
  onCreated: (key: ApiKey) => void;
}

/** Why a member cannot hold a key yet, or null when they can. */
function blockedReason(member: ApiMember): string | null {
  if (member.status !== "active") return "Suspended";
  if (!member.has_sign_in) return "No sign-in";
  if (!member.can_use_api) return "No 'Use the API'";
  return null;
}

/**
 * New key, in two steps: the form, then the key itself, shown once. Keeping
 * the secret inside the dialog means it can never scroll out of view under a
 * list, and closing before copying asks first, since it cannot be shown again.
 */
export function ApiKeyDialog({
  open,
  onOpenChange,
  isOwner,
  memberId,
  members,
  available,
  onCreated,
}: ApiKeyDialogProps) {
  const agents = React.useMemo(
    () => members.filter((m) => m.id !== memberId && m.role === "agent"),
    [members, memberId],
  );
  const eligible = agents.filter((m) => !blockedReason(m));
  // Keys are mostly made for agents: preselect the only one there is.
  const defaultFor = isOwner && eligible.length === 1 ? eligible[0].id : memberId;

  const [step, setStep] = React.useState<"form" | "secret">("form");
  const [keyFor, setKeyFor] = React.useState(defaultFor);
  const [name, setName] = React.useState("");
  const [scopes, setScopes] = React.useState<ApiScope[]>([]);
  const [days, setDays] = React.useState(String(DEFAULT_API_KEY_DAYS));
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const secretRef = React.useRef<HTMLElement>(null);
  const { confirm, dialog } = useConfirmationDialog();

  // Fresh form on every open.
  React.useEffect(() => {
    if (!open) return;
    setStep("form");
    setKeyFor(defaultFor);
    setName("");
    setScopes([]);
    setDays(String(DEFAULT_API_KEY_DAYS));
    setError("");
    setSecret("");
    setCopied(false);
    // Only on opening: defaultFor settles once members load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const forSelf = keyFor === memberId;
  const target = members.find((m) => m.id === keyFor);
  const holdable: ApiScope[] = forSelf ? available : (target?.api_scopes ?? []);

  const chooseOwner = (id: string) => {
    setKeyFor(id);
    const next =
      id === memberId ? available : (members.find((m) => m.id === id)?.api_scopes ?? []);
    setScopes((current) => current.filter((scope) => next.includes(scope)));
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError("Give the key a name.");
    if (scopes.length === 0) return setError("Choose at least one thing it can read or change.");
    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          scopes,
          days: Number(days),
          ...(forSelf ? {} : { member_id: keyFor }),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not create the key.");
      onCreated(payload.data.key);
      setSecret(payload.data.secret);
      setStep("secret");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the key.");
    } finally {
      setCreating(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast("success", "Key copied");
    } catch {
      // Clipboard blocked: select it so a plain Ctrl+C works.
      const node = secretRef.current;
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      toast("error", "Copy was blocked. The key is selected; press Ctrl+C.");
    }
  };

  const close = async (next: boolean) => {
    if (next) return onOpenChange(true);
    if (creating) return;
    if (
      step === "secret" &&
      !copied &&
      !(await confirm({
        title: "Close without copying?",
        description:
          "The key is never shown again. If it is lost, revoke it and make a new one.",
        confirmLabel: "Close",
        variant: "warning",
      }))
    )
      return;
    onOpenChange(false);
  };

  const ownerOptions = [
    { value: memberId, label: "You" },
    ...agents.map((member) => {
      const blocked = blockedReason(member);
      return {
        value: member.id,
        label: member.name,
        disabled: !!blocked,
        detail: blocked ?? "Agent",
      };
    }),
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => void close(next)}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto">
        {dialog}
        {step === "form" ? (
          <form onSubmit={create} className="space-y-5" noValidate>
            <DialogHeader>
              <DialogTitle>New key</DialogTitle>
              <DialogDescription className="sr-only">
                Choose who the key acts as and what it can read or change.
              </DialogDescription>
            </DialogHeader>

            {error && (
              <p role="alert" className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error">
                {error}
              </p>
            )}

            <div className="space-y-4">
              {isOwner && agents.length > 0 && (
                <Select
                  label="Key for"
                  value={keyFor}
                  onChange={chooseOwner}
                  options={ownerOptions}
                  helperText="It acts as this person and can never do more than they can."
                />
              )}
              <TextInput
                label="Name"
                placeholder={forSelf ? "Weekly report script" : `${target?.name ?? "Agent"}'s connection`}
                value={name}
                onChange={setName}
                maxLength={100}
                autoFocus
                required
              />

              <ApiScopePicker
                holdable={holdable}
                selected={scopes}
                onChange={setScopes}
                notHeld={`${forSelf ? "You do" : `${target?.name ?? "This person"} does`} not have this permission.`}
              />

              <Disclosure summary="Advanced" contentClassName="space-y-4">
                <Select
                  label="Expires after"
                  value={days}
                  onChange={setDays}
                  options={API_KEY_LIFETIMES.map((option) => ({
                    value: String(option.days),
                    label: option.label,
                  }))}
                  helperText="A key stops working when it expires; make a new one before then."
                />
              </Disclosure>
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => void close(false)} disabled={creating}>
                Cancel
              </Button>
              <Button type="submit" loading={creating}>
                Create key
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-5">
            <DialogHeader>
              <DialogTitle>Copy your key</DialogTitle>
              <DialogDescription className="sr-only">
                The new key, shown once. Copy it before closing.
              </DialogDescription>
            </DialogHeader>
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              This is the only time it is shown. Paste it wherever the agent or script reads it.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <code
                ref={secretRef}
                className="min-w-0 flex-1 select-all break-all rounded-lg bg-[rgba(var(--ink),0.06)] px-3 py-2.5 font-mono text-xs text-foreground"
              >
                {secret}
              </code>
              <Button
                type="button"
                variant={copied ? "secondary" : "default"}
                onClick={() => void copy()}
                autoFocus
                className="shrink-0"
              >
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => void close(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
