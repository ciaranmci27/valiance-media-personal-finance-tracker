"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BookOpen,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  ShieldOff,
  TriangleAlert,
} from "lucide-react";
import {
  MobileMenuButton,
  HeaderControls,
} from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { Select } from "@/components/ui/inputs/Select";
import { toast } from "@/components/ui/toast";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  API_KEY_LIFETIMES,
  API_SCOPES,
  DEFAULT_API_KEY_DAYS,
  type ApiScope,
} from "@/lib/api/scopes";
import { cn } from "@/lib/utils";

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  team_member_id: string | null;
  created_by: string | null;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  disabled_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface Member {
  id: string;
  name: string;
  role: string;
  status: string;
  /** Owner view only: whether a key can act as this member, and what it could carry. */
  has_sign_in?: boolean;
  can_use_api?: boolean;
  api_scopes?: ApiScope[];
}

interface RequestLog {
  id: string;
  at: string;
  api_key_id: string | null;
  team_member_id: string | null;
  method: string;
  path: string;
  operation: string | null;
  status: number;
  error_code: string | null;
  duration_ms: number | null;
  via?: "rest" | "mcp";
}

interface Props {
  /** Scopes this person holds, so a key can carry them. */
  available: ApiScope[];
  isOwner: boolean;
  memberId: string;
}

const scopeLabel = (key: string) =>
  API_SCOPES.find((scope) => scope.key === key)?.label ?? key;

function keyState(key: ApiKey): "active" | "revoked" | "expired" | "disabled" {
  if (key.revoked_at) return "revoked";
  if (key.disabled_at) return "disabled";
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now())
    return "expired";
  return "active";
}

function when(value: string | null, fallback = "Never") {
  if (!value) return fallback;
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {children}
      </h2>
      <div className="flex-1 h-px bg-border/50" />
    </div>
  );
}

export function ApiSettingsContent({ available, isOwner, memberId }: Props) {
  const [keys, setKeys] = React.useState<ApiKey[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [requests, setRequests] = React.useState<RequestLog[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [name, setName] = React.useState("");
  const [scopes, setScopes] = React.useState<ApiScope[]>([]);
  const [days, setDays] = React.useState(String(DEFAULT_API_KEY_DAYS));
  // Owner only: whose key this is. Defaults to the owner's own.
  const [keyFor, setKeyFor] = React.useState(memberId);
  const [creating, setCreating] = React.useState(false);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [showInactive, setShowInactive] = React.useState(false);
  const { confirm, dialog } = useConfirmationDialog();

  const load = React.useCallback(async () => {
    try {
      const response = await fetch("/api/admin/api-keys", {
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || "Could not load API keys.");
      setKeys(payload.data.keys);
      setMembers(payload.data.members);
      setRequests(payload.data.requests);
    } catch (error) {
      toast(
        "error",
        error instanceof Error ? error.message : "Could not load API keys.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const memberName = (id: string | null) =>
    members.find((m) => m.id === id)?.name ?? "Former member";
  const keyName = (id: string | null) =>
    keys.find((k) => k.id === id)?.name ?? "Unknown key";
  const active = keys.filter((key) => keyState(key) === "active");
  const forSelf = keyFor === memberId;
  const target = members.find((m) => m.id === keyFor);
  const holdable: ApiScope[] = forSelf ? available : (target?.api_scopes ?? []);
  // The owner can also make keys for agents; people make their own.
  const others = members.filter((m) => m.id !== memberId && m.role === "agent");

  const chooseOwner = (id: string) => {
    setKeyFor(id);
    const next =
      id === memberId
        ? available
        : (members.find((m) => m.id === id)?.api_scopes ?? []);
    setScopes((current) => current.filter((scope) => next.includes(scope)));
  };
  const inactive = keys.filter((key) => keyState(key) !== "active");

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || scopes.length === 0) return;
    setCreating(true);
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
      if (!response.ok)
        throw new Error(payload.error || "Could not create the key.");
      setKeys((current) => [payload.data.key, ...current]);
      setSecret(payload.data.secret);
      setCopied(false);
      setName("");
      setScopes([]);
      setDays(String(DEFAULT_API_KEY_DAYS));
      setKeyFor(memberId);
    } catch (error) {
      toast(
        "error",
        error instanceof Error ? error.message : "Could not create the key.",
      );
    } finally {
      setCreating(false);
    }
  };

  const copy = async () => {
    if (!secret) return;
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    toast("success", "Key copied");
  };

  const revoke = async (key: ApiKey) => {
    const ok = await confirm({
      title: "Revoke this key?",
      description: `Anything using "${key.name}" stops working right away. A revoked key cannot be restored.`,
      confirmLabel: "Revoke key",
      variant: "danger",
    });
    if (!ok) return;
    try {
      const response = await fetch(
        `/api/admin/api-keys/${encodeURIComponent(key.id)}/revoke`,
        { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || "Could not revoke the key.");
      setKeys((current) =>
        current.map((k) => (k.id === key.id ? payload.data : k)),
      );
      toast("success", "Key revoked");
    } catch (error) {
      toast(
        "error",
        error instanceof Error ? error.message : "Could not revoke the key.",
      );
    }
  };

  const keyRow = (key: ApiKey) => {
    const state = keyState(key);
    const mine = key.team_member_id === memberId;
    return (
      <li key={key.id} className="glass-card rounded-xl p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-foreground truncate">{key.name}</p>
              {state !== "active" && (
                <Badge variant={state === "revoked" ? "danger" : "warning"}>
                  {state === "revoked"
                    ? "Revoked"
                    : state === "expired"
                      ? "Expired"
                      : "Disabled"}
                </Badge>
              )}
              {isOwner && !mine && (
                <Badge variant="info">{memberName(key.team_member_id)}</Badge>
              )}
            </div>
            <code className="block font-mono text-xs text-muted-foreground">
              {key.key_prefix}…
            </code>
            <div className="flex flex-wrap gap-1.5">
              {key.scopes.map((scope) => (
                <Badge key={scope}>{scopeLabel(scope)}</Badge>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Created {when(key.created_at)} · Expires{" "}
              {when(key.expires_at, "never")} · Last used{" "}
              {when(key.last_used_at)}
            </p>
          </div>
          {state === "active" && (
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg"
              onClick={() => void revoke(key)}
              aria-label={`Revoke ${key.name}`}
            >
              <ShieldOff className="h-4 w-4" aria-hidden="true" />
              Revoke
            </Button>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {dialog}
      <div className="flex flex-wrap items-center justify-between gap-y-2">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <KeyRound className="h-5 w-5 text-teal-light" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">API</h1>
            <p className="text-sm text-muted-foreground">
              Keys for your agents and scripts
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/settings/api/reference">
            <Button size="sm" variant="secondary" className="rounded-xl gap-1">
              <BookOpen className="h-4 w-4" aria-hidden="true" />
              Reference
            </Button>
          </Link>
          <Link href="/settings">
            <Button size="sm" className="rounded-xl gap-1">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back
            </Button>
          </Link>
          <HeaderControls />
        </div>
      </div>

      <div className="glass-card rounded-xl p-4 text-sm text-muted-foreground space-y-1">
        <p>
          A key belongs to you and can only do what you can, limited to the
          parts you choose. Every request is checked in the database and logged.
          Suspending a person stops all of their keys.
          {isOwner &&
            " You can also create a key for an agent; it can only do what that agent can."}
        </p>
        <p>
          The same key works for the REST API and the MCP server, which agents
          such as Hermes connect to. See Reference.
        </p>
        <p>
          Agents never change your official numbers: anything they write to the
          books is a draft you review and post in Accounting. Tracker answers
          are labelled as tracker data.
        </p>
      </div>

      {secret && (
        <div
          role="status"
          aria-live="polite"
          className="glass-card rounded-xl border border-warning/30 p-4 space-y-3"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <TriangleAlert
              className="h-4 w-4 text-warning"
              aria-hidden="true"
            />
            Copy this key now. It will not be shown again.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-[rgba(var(--ink),0.06)] px-3 py-2 font-mono text-xs text-foreground">
              {secret}
            </code>
            <Button
              size="sm"
              className="rounded-lg"
              onClick={() => void copy()}
            >
              {copied ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-lg"
            onClick={() => setSecret(null)}
          >
            I have saved it
          </Button>
        </div>
      )}

      <div className="space-y-3">
        <SectionTitle>New key</SectionTitle>
        <form onSubmit={create} className="glass-card rounded-xl p-6 space-y-4">
          {isOwner && others.length > 0 && (
            <Select
              label="Key for"
              description="The key acts as this person, with their permissions"
              value={keyFor}
              onChange={chooseOwner}
              options={[
                { value: memberId, label: "You" },
                ...others.map((member) => {
                  const blocked =
                    member.status !== "active"
                      ? "Suspended"
                      : !member.has_sign_in
                        ? "No sign-in"
                        : !member.can_use_api
                          ? "No 'Use the API'"
                          : null;
                  return {
                    value: member.id,
                    label: member.name,
                    disabled: !!blocked,
                    detail:
                      blocked ??
                      (member.role === "agent" ? "Agent" : undefined),
                  };
                }),
              ]}
            />
          )}
          <TextInput
            label="Name"
            description="Who will use it"
            placeholder="Jeff's weekly report"
            value={name}
            onChange={setName}
            maxLength={100}
            required
          />
          {(["read", "write"] as const).map((access) => (
            <fieldset key={access} className="space-y-2">
              <legend className="text-sm font-medium text-foreground mb-1">
                {access === "read" ? "What it can read" : "What it can change"}
              </legend>
              {API_SCOPES.filter((scope) => scope.access === access).map(
                (scope) => {
                  const held = holdable.includes(scope.key);
                  return (
                    <div key={scope.key}>
                      <Checkbox
                        checked={scopes.includes(scope.key)}
                        disabled={!held}
                        onChange={(checked) =>
                          setScopes((current) =>
                            checked
                              ? [...current, scope.key]
                              : current.filter((s) => s !== scope.key),
                          )
                        }
                        label={scope.label}
                        description={
                          held
                            ? scope.description
                            : `${scope.description} ${forSelf ? "You do" : `${target?.name ?? "This person"} does`} not hold this permission.`
                        }
                      />
                    </div>
                  );
                },
              )}
            </fieldset>
          ))}
          <Select
            label="Expires after"
            value={days}
            onChange={setDays}
            options={API_KEY_LIFETIMES.map((option) => ({
              value: String(option.days),
              label: option.label,
            }))}
          />
          <Button
            type="submit"
            size="sm"
            className="rounded-lg"
            disabled={creating || !name.trim() || scopes.length === 0}
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="h-4 w-4" aria-hidden="true" />
            )}
            Create key
          </Button>
        </form>
      </div>

      <div className="space-y-3">
        <SectionTitle>{isOwner ? "All keys" : "Your keys"}</SectionTitle>
        {loading ? (
          <p className="px-1 text-sm text-muted-foreground">Loading keys…</p>
        ) : active.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">No active keys.</p>
        ) : (
          <ul className="space-y-2">{active.map(keyRow)}</ul>
        )}
        {inactive.length > 0 && (
          <div className="space-y-2">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg"
              aria-expanded={showInactive}
              onClick={() => setShowInactive((open) => !open)}
            >
              {showInactive ? "Hide" : "Show"} {inactive.length} revoked or
              expired
            </Button>
            {showInactive && (
              <ul className="space-y-2">{inactive.map(keyRow)}</ul>
            )}
          </div>
        )}
      </div>

      {isOwner && (
        <div className="space-y-3">
          <SectionTitle>Recent requests</SectionTitle>
          {requests.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">
              No requests yet.
            </p>
          ) : (
            <div className="glass-card rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  The latest 50 API requests
                </caption>
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-4 py-2 font-medium">
                      When
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Who
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Request
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-2 font-medium text-right"
                    >
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((request) => (
                    <tr
                      key={request.id}
                      className="border-t border-border/50 align-top"
                    >
                      <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                        {new Date(request.at).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="px-4 py-2">
                        <span className="block text-foreground">
                          {request.team_member_id
                            ? memberName(request.team_member_id)
                            : "Unknown"}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {request.api_key_id
                            ? keyName(request.api_key_id)
                            : "No valid key"}
                        </span>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs break-all text-muted-foreground">
                        {request.via === "mcp" && (
                          <Badge variant="info" className="mr-1.5 font-sans">
                            MCP
                          </Badge>
                        )}
                        {request.path}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <span
                          className={cn(
                            "font-medium",
                            request.status < 400
                              ? "text-success"
                              : "text-error",
                          )}
                        >
                          {request.status}
                        </span>
                        {request.error_code && (
                          <span className="block text-xs text-muted-foreground">
                            {request.error_code}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
