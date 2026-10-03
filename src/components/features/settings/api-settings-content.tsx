"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, BookOpen, KeyRound, Plus, ShieldOff, SlidersHorizontal } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Disclosure } from "@/components/ui/disclosure";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { initialsOf } from "@/lib/access-control";
import { API_SCOPES, type ApiScope } from "@/lib/api/scopes";
import { cn } from "@/lib/utils";
import { ApiKeyDialog } from "./api-key-dialog";
import { ApiKeyAccessDialog } from "./api-key-access-dialog";

export interface ApiKey {
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
  /** When the key's settings last changed; sent back with an edit so two edits never overwrite each other. */
  updated_at: string;
}

export interface ApiMember {
  id: string;
  name: string;
  role: string;
  status: string;
  /** Owner view only: whether a key can act as this member, and what it could carry. */
  has_sign_in?: boolean;
  can_use_api?: boolean;
  api_scopes?: ApiScope[];
}

export interface ApiRequest {
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

type KeyState = "active" | "revoked" | "expired" | "disabled";

function keyState(key: ApiKey): KeyState {
  if (key.revoked_at) return "revoked";
  if (key.disabled_at) return "disabled";
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) return "expired";
  return "active";
}

const DAY = 86_400_000;
const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

/** "2 min ago", "yesterday", "in 12 months": the distance, not the date. */
function fromNow(value: string): string {
  const diff = new Date(value).getTime() - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60_000) return "just now";
  if (abs < 3_600_000) return relative.format(Math.round(diff / 60_000), "minute");
  if (abs < DAY) return relative.format(Math.round(diff / 3_600_000), "hour");
  if (abs < 30 * DAY) return relative.format(Math.round(diff / DAY), "day");
  if (abs < 365 * DAY) return relative.format(Math.round(diff / (30 * DAY)), "month");
  return relative.format(Math.round(diff / (365 * DAY)), "year");
}

const fullDate = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Reads an agent repeats on a timer to notice changes (Alex polls the books' change counter). */
const ROUTINE_OPERATIONS = new Set(["books.revision"]);

/** Plain names for a sentence; the scope labels are written for checkboxes. */
const READ_WORDS: Partial<Record<string, string>> = {
  "accounting.read": "books",
  "income.read": "income",
  "expenses.read": "expenses",
  "net_worth.read": "net worth",
  "tax.read": "tax",
};

function AccessSummary({ scopes }: { scopes: string[] }) {
  const reads = API_SCOPES.filter((s) => s.access === "read" && scopes.includes(s.key));
  const readTotal = API_SCOPES.filter((s) => s.access === "read").length;
  const words = reads.map((s) => READ_WORDS[s.key] ?? s.label.toLowerCase());
  const sentence =
    reads.length === 0
      ? "No read access"
      : reads.length === readTotal
        ? "Reads everything"
        : `Reads ${words.slice(0, 3).join(", ")}${words.length > 3 ? ` +${words.length - 3}` : ""}`;
  const drafts = scopes.includes("accounting.draft");
  const edits = scopes.some((s) => s.endsWith(".manage"));
  const full = API_SCOPES.filter((s) => scopes.includes(s.key)).map((s) => s.label);
  return (
    <Tooltip content={full.join(", ") || "Nothing"} wide>
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className="text-sm text-foreground">{sentence}</span>
        {drafts && (
          <Badge variant="copper" size="sm">
            Drafts books
          </Badge>
        )}
        {edits && (
          <Badge variant="warning" size="sm">
            Edits trackers
          </Badge>
        )}
      </span>
    </Tooltip>
  );
}

function Avatar({ name, muted }: { name: string; muted?: boolean }) {
  return (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        muted ? "bg-[rgba(var(--ink),0.06)] text-muted-foreground" : "bg-primary/15 text-teal-light",
      )}
      aria-hidden="true"
    >
      {initialsOf(name) || "?"}
    </span>
  );
}

function ExpiryCell({ apiKey }: { apiKey: ApiKey }) {
  const state = keyState(apiKey);
  if (state === "revoked") return <Badge variant="danger" dot>Revoked</Badge>;
  if (state === "disabled") return <Badge variant="warning" dot>Disabled</Badge>;
  if (state === "expired") return <Badge variant="danger" dot>Expired</Badge>;
  if (!apiKey.expires_at) return <span className="text-sm text-muted-foreground">Never</span>;
  const soon = new Date(apiKey.expires_at).getTime() - Date.now() < 14 * DAY;
  return soon ? (
    <Badge variant="warning" dot title={fullDate(apiKey.expires_at)}>
      {fromNow(apiKey.expires_at)}
    </Badge>
  ) : (
    <span className="text-sm text-muted-foreground" title={fullDate(apiKey.expires_at)}>
      {fromNow(apiKey.expires_at)}
    </span>
  );
}

export function ApiSettingsContent({ available, isOwner, memberId }: Props) {
  const [keys, setKeys] = React.useState<ApiKey[]>([]);
  const [members, setMembers] = React.useState<ApiMember[]>([]);
  const [requests, setRequests] = React.useState<ApiRequest[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<ApiKey | null>(null);
  const editTrigger = React.useRef<HTMLElement | null>(null);
  const [showInactive, setShowInactive] = React.useState(false);
  const [tab, setTab] = React.useState<"keys" | "activity">("keys");
  const [showRoutine, setShowRoutine] = React.useState(false);
  const { confirm, dialog } = useConfirmationDialog();

  const load = React.useCallback(async () => {
    try {
      const response = await fetch("/api/admin/api-keys", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load API keys.");
      setKeys(payload.data.keys);
      setMembers(payload.data.members);
      setRequests(payload.data.requests);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : "Could not load API keys.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const memberName = (id: string | null) =>
    members.find((m) => m.id === id)?.name ?? "Former member";
  const keyName = (id: string | null) => keys.find((k) => k.id === id)?.name ?? "Unknown key";
  const active = keys.filter((key) => keyState(key) === "active");
  const inactive = keys.filter((key) => keyState(key) !== "active");
  const shown = showInactive ? [...active, ...inactive] : active;
  // An agent's change-counter polls are housekeeping, not work: hidden by
  // default so what it actually did is not buried under them.
  const work = requests.filter((r) => !ROUTINE_OPERATIONS.has(r.operation ?? ""));
  const routineCount = requests.length - work.length;

  const revoke = async (key: ApiKey) => {
    const ok = await confirm({
      title: "Revoke this key?",
      description: `Anything using "${key.name}" stops working right away. A revoked key cannot be restored.`,
      confirmLabel: "Revoke key",
      variant: "danger",
    });
    if (!ok) return;
    try {
      const response = await fetch(`/api/admin/api-keys/${encodeURIComponent(key.id)}/revoke`, {
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not revoke the key.");
      setKeys((current) => current.map((k) => (k.id === key.id ? payload.data : k)));
      toast("success", "Key revoked");
    } catch (error) {
      toast("error", error instanceof Error ? error.message : "Could not revoke the key.");
    }
  };

  // What a key for this member may carry: your own permissions, or the member's.
  const holdableFor = (key: ApiKey): string[] =>
    key.team_member_id === memberId
      ? available
      : (members.find((m) => m.id === key.team_member_id)?.api_scopes ?? []);
  // The create rules: your own keys, and the owner also an agent's.
  const canEdit = (key: ApiKey) =>
    key.team_member_id === memberId ||
    (isOwner && members.find((m) => m.id === key.team_member_id)?.role === "agent");

  // The dialog opens as the actions menu closes, so Radix has no button to give
  // focus back to. Remember the menu's own button (the menu is labelled by it).
  const openEdit = (key: ApiKey) => {
    const menu = document.activeElement?.closest('[role="menu"]');
    const triggerId = menu?.getAttribute("aria-labelledby");
    editTrigger.current = triggerId ? document.getElementById(triggerId) : null;
    setEditing(key);
  };

  const keyActions = (key: ApiKey) =>
    keyState(key) === "active" ? (
      <RowActionsMenu
        label={`Actions for ${key.name}`}
        actions={[
          ...(canEdit(key)
            ? [
                {
                  label: "Edit access",
                  icon: <SlidersHorizontal size={14} aria-hidden="true" />,
                  onSelect: () => openEdit(key),
                },
              ]
            : []),
          {
            label: "Revoke",
            icon: <ShieldOff size={14} aria-hidden="true" />,
            variant: "danger",
            onSelect: () => void revoke(key),
          },
        ]}
      />
    ) : null;

  const keyIdentity = (apiKey: ApiKey) => (
    <div className="min-w-0">
      <div className="truncate font-medium text-foreground">{apiKey.name}</div>
      <code className="font-mono text-xs text-muted-foreground">{apiKey.key_prefix}...</code>
    </div>
  );

  const keyOwner = (apiKey: ApiKey) => {
    const mine = apiKey.team_member_id === memberId;
    const name = mine ? "You" : memberName(apiKey.team_member_id);
    return (
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar name={mine ? memberName(memberId) : name} muted={keyState(apiKey) !== "active"} />
        <span className="truncate text-sm text-foreground">{name}</span>
      </div>
    );
  };

  const keyColumns: DataTableColumn<ApiKey>[] = [
    {
      key: "name",
      header: "Key",
      render: keyIdentity,
      sortValue: (row) => row.name.toLowerCase(),
    },
    ...(isOwner
      ? [
          {
            key: "for",
            header: "For",
            render: keyOwner,
            sortValue: (row: ApiKey) => memberName(row.team_member_id).toLowerCase(),
            width: "180px",
          },
        ]
      : []),
    {
      key: "access",
      header: "Access",
      render: (row) => <AccessSummary scopes={row.scopes} />,
      sortValue: (row) => row.scopes.length,
    },
    {
      key: "expires",
      header: "Expires",
      render: (row) => <ExpiryCell apiKey={row} />,
      sortValue: (row) => (row.expires_at ? new Date(row.expires_at).getTime() : Infinity),
      width: "150px",
    },
    {
      key: "used",
      header: "Last used",
      render: (row) =>
        row.last_used_at ? (
          <span className="text-sm text-muted-foreground" title={fullDate(row.last_used_at)}>
            {fromNow(row.last_used_at)}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">Never</span>
        ),
      sortValue: (row) => (row.last_used_at ? new Date(row.last_used_at).getTime() : 0),
      width: "130px",
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: "56px",
      render: keyActions,
    },
  ];

  const keyCard = (row: ApiKey) => (
    <div className="glass-card space-y-3 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        {keyIdentity(row)}
        {keyActions(row)}
      </div>
      {isOwner && keyOwner(row)}
      <AccessSummary scopes={row.scopes} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          Expires <ExpiryCell apiKey={row} />
        </span>
        <span>Last used {row.last_used_at ? fromNow(row.last_used_at) : "never"}</span>
      </div>
    </div>
  );

  const requestColumns: DataTableColumn<ApiRequest>[] = [
    {
      key: "at",
      header: "When",
      render: (row) => (
        <span className="whitespace-nowrap text-sm text-muted-foreground" title={fullDate(row.at)}>
          {fromNow(row.at)}
        </span>
      ),
      sortValue: (row) => new Date(row.at).getTime(),
      width: "120px",
    },
    {
      key: "who",
      header: "Who",
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-foreground">
            {row.team_member_id ? memberName(row.team_member_id) : "Unknown"}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {row.api_key_id ? keyName(row.api_key_id) : "No valid key"}
          </div>
        </div>
      ),
      sortValue: (row) => (row.team_member_id ? memberName(row.team_member_id) : "").toLowerCase(),
      width: "200px",
    },
    {
      key: "request",
      header: "Request",
      render: (row) => (
        <Tooltip content={`${row.method} ${row.path}`} wide>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {row.via === "mcp" && (
              <Badge variant="info" size="sm">
                MCP
              </Badge>
            )}
            <span className="truncate font-mono text-xs text-foreground">
              {row.operation ?? row.path}
            </span>
          </span>
        </Tooltip>
      ),
      sortValue: (row) => row.operation ?? row.path,
    },
    {
      key: "result",
      header: "Result",
      render: (row) => (
        <div className="space-y-0.5">
          <Badge variant={row.status < 400 ? "success" : "danger"} dot size="sm">
            {row.status}
          </Badge>
          {row.error_code && (
            <div className="text-xs text-muted-foreground">{row.error_code}</div>
          )}
        </div>
      ),
      sortValue: (row) => row.status,
      width: "150px",
    },
    {
      key: "duration",
      header: "Time",
      align: "right",
      numeric: true,
      render: (row) => (
        <span className="text-sm tabular-nums text-muted-foreground">
          {row.duration_ms === null ? "" : `${row.duration_ms} ms`}
        </span>
      ),
      sortValue: (row) => row.duration_ms ?? 0,
      width: "90px",
    },
  ];

  const requestCard = (row: ApiRequest) => (
    <div className="glass-card space-y-2 rounded-xl p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {row.via === "mcp" && (
            <Badge variant="info" size="sm">
              MCP
            </Badge>
          )}
          <span className="truncate font-mono text-xs text-foreground">{row.operation ?? row.path}</span>
        </span>
        <Badge variant={row.status < 400 ? "success" : "danger"} dot size="sm">
          {row.status}
        </Badge>
      </div>
      <div className="text-sm text-muted-foreground">
        {row.team_member_id ? memberName(row.team_member_id) : "Unknown"} · {fromNow(row.at)}
        {row.error_code ? ` · ${row.error_code}` : ""}
      </div>
    </div>
  );

  const subtitle = loading
    ? "Loading keys"
    : `${active.length} active ${active.length === 1 ? "key" : "keys"}`;

  return (
    <div className="space-y-5 lg:space-y-6">
      {dialog}
      <PageHeader
        title="API"
        subtitle={subtitle}
        actions={
          <>
            <Button asChild variant="ghost" size="icon-sm" aria-label="Back to settings">
              <Link href="/settings">
                <ArrowLeft aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="secondary" size="sm">
              <Link href="/settings/api/reference">
                <BookOpen aria-hidden="true" />
                Reference
              </Link>
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              New key
            </Button>
          </>
        }
      />

      {isOwner && (
        <div role="group" aria-label="Show" className="seg-track seg-sm w-fit">
          {(
            [
              ["keys", "Keys"],
              ["activity", "Activity"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={tab === value}
              onClick={() => setTab(value)}
              className={cn(
                "seg-item",
                tab === value && "is-active",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {tab === "keys" ? (
        <div className="space-y-4">
          <DataTable
            columns={keyColumns}
            data={shown}
            keyExtractor={(row) => row.id}
            mobileCard={keyCard}
            busy={loading}
            skeletonRows={2}
            rowClassName={(row) => (keyState(row) === "active" ? undefined : "opacity-70")}
            emptyState={
              <div className="space-y-3 py-12 text-center">
                <KeyRound className="mx-auto h-8 w-8 text-muted-foreground/60" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">
                  No keys yet. Make one for an agent or a script.
                </p>
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus aria-hidden="true" />
                  New key
                </Button>
              </div>
            }
          />
          {inactive.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showInactive}
              onClick={() => setShowInactive((open) => !open)}
            >
              {showInactive ? "Hide" : "Show"} {inactive.length} revoked or expired
            </Button>
          )}
          <Disclosure summary="How keys work">
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>
                A key acts as one person and can never do more than they can, only the parts you tick.
                {isOwner && " You can make keys for agents too."}
              </li>
              <li>Every request is checked in the database and logged. Suspending a person stops all of their keys.</li>
              <li>The same key works for the REST API and the MCP server that agents connect to.</li>
              <li>
                Agents never change your official numbers: books changes are drafts you review and post,
                and tracker answers are labelled as tracker data.
              </li>
            </ul>
          </Disclosure>
        </div>
      ) : (
        <div className="space-y-4">
          <DataTable
            columns={requestColumns}
            data={showRoutine ? requests : work}
            keyExtractor={(row) => row.id}
            mobileCard={requestCard}
            busy={loading}
            skeletonRows={4}
            initialSort={{ key: "at", dir: "desc" }}
            emptyState={
              <div className="py-12 text-center text-sm text-muted-foreground">
                {requests.length === 0
                  ? "No requests yet. Calls from agents and scripts show up here."
                  : "Only routine checks so far."}
              </div>
            }
          />
          {routineCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={showRoutine}
              onClick={() => setShowRoutine((on) => !on)}
            >
              {showRoutine ? "Hide" : "Show"} {routineCount} routine{" "}
              {routineCount === 1 ? "check" : "checks"}
            </Button>
          )}
        </div>
      )}

      <ApiKeyDialog
        open={creating}
        onOpenChange={setCreating}
        isOwner={isOwner}
        memberId={memberId}
        members={members}
        available={available}
        onCreated={(key) => setKeys((current) => [key, ...current])}
      />
      <ApiKeyAccessDialog
        apiKey={editing}
        onClose={() => setEditing(null)}
        holdable={editing ? holdableFor(editing) : []}
        notHeld={`${editing?.team_member_id === memberId ? "You do" : `${memberName(editing?.team_member_id ?? null)} does`} not have this permission.`}
        onSaved={(saved) => setKeys((current) => current.map((k) => (k.id === saved.id ? saved : k)))}
        returnFocusRef={editTrigger}
      />
    </div>
  );
}
