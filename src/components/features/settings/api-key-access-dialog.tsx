"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { toast } from "@/components/ui/toast";
import { API_SCOPES, type ApiScope } from "@/lib/api/scopes";
import type { ApiKey } from "./api-settings-content";
import { ApiScopePicker } from "./api-scope-picker";

interface ApiKeyAccessDialogProps {
  /** The key being edited; null keeps the dialog closed. */
  apiKey: ApiKey | null;
  onClose: () => void;
  /** Scopes the key's member holds. */
  holdable: readonly string[];
  /** Why a scope cannot be ticked, e.g. "Alex A. does not have this permission." */
  notHeld: string;
  /** The key as the server now has it, after a save or a conflicting edit. */
  onSaved: (key: ApiKey) => void;
  /** Where focus goes when the dialog closes: the row's actions button. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((scope) => b.includes(scope));

/**
 * Edit key: its name and the same scope picker as New key, ticked with what
 * the key carries now. The key itself does not change, so nothing has to be
 * pasted again; the new access applies from the key's next request.
 */
export function ApiKeyAccessDialog({
  apiKey,
  onClose,
  holdable,
  notHeld,
  onSaved,
  returnFocusRef,
}: ApiKeyAccessDialogProps) {
  const [base, setBase] = React.useState<ApiKey | null>(apiKey);
  const [scopes, setScopes] = React.useState<string[]>([]);
  const [name, setName] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  // Fresh form for every key opened.
  React.useEffect(() => {
    if (!apiKey) return;
    setBase(apiKey);
    setScopes(apiKey.scopes);
    setName(apiKey.name);
    setError("");
    // Only when another key opens: a refreshed list must not undo the edit in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey?.id]);

  const close = (open: boolean) => {
    if (open || saving) return;
    onClose();
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!base) return;
    const trimmed = name.trim();
    if (!trimmed) return setError("Give the key a name.");
    if (scopes.length === 0) return setError("Choose at least one thing it can read or change.");
    const lost = API_SCOPES.filter((s) => scopes.includes(s.key) && !holdable.includes(s.key));
    if (lost.length > 0)
      return setError(`Untick what this key can no longer carry: ${lost.map((s) => s.label).join(", ")}.`);
    const renamed = trimmed !== base.name;
    if (sameSet(scopes, base.scopes) && !renamed) return onClose();
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/api-keys/${encodeURIComponent(base.id)}/scopes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scopes,
          expected_updated_at: base.updated_at,
          ...(renamed ? { name: trimmed } : {}),
        }),
      });
      const payload = await response.json();
      if (response.status === 409 && payload.data) {
        // Someone else saved first: show their version and let the owner decide again.
        setBase(payload.data);
        setScopes(payload.data.scopes);
        setName(payload.data.name);
        onSaved(payload.data);
        throw new Error(payload.error);
      }
      if (!response.ok) throw new Error(payload.error || "Could not save the key.");
      onSaved(payload.data);
      toast("success", "Key updated");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the key.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!apiKey} onOpenChange={close}>
      <DialogContent
        className="max-h-[92dvh] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <form onSubmit={save} className="space-y-5" noValidate>
          <DialogHeader>
            <DialogTitle>Edit key</DialogTitle>
            <DialogDescription className="sr-only">
              Change the name of {base?.name ?? "this key"} and what it can read or change.
            </DialogDescription>
          </DialogHeader>

          {error && (
            <p role="alert" className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error">
              {error}
            </p>
          )}

          <div className="space-y-4">
            <TextInput
              label="Name"
              value={name}
              onChange={setName}
              maxLength={100}
              required
              disabled={saving}
            />
            <ApiScopePicker
              holdable={holdable}
              selected={scopes}
              onChange={(next: ApiScope[]) => setScopes(next)}
              notHeld={notHeld}
            />
            <p className="text-xs text-muted-foreground">
              Changes apply to the existing key; the secret stays the same.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
