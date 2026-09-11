"use client";
import { AlertTriangle, ArrowRight, Info, OctagonAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FeedData } from "@/lib/accounting/feeds";
import type { BooksMetadata } from "./types";
import { countLabel } from "./format";

/**
 * What the books need from the owner right now, in one place. Every
 * accounting screen shows these under its header, so a blocked feed or a
 * half-finished setup is never something the owner has to go looking for.
 */
export type BooksNotice = {
  key: string;
  level: "critical" | "warning" | "info";
  title: string;
  detail: string;
  action?: { label: string; onSelect: () => void };
};

const MAPPING_ERROR = "Discover and review the company account mappings";

export function booksNotices({
  feeds,
  manage,
  demo,
  onFeeds,
  onSettings,
}: {
  feeds: FeedData | null;
  manage: BooksMetadata;
  demo: boolean;
  onFeeds: () => void;
  onSettings: () => void;
}): BooksNotice[] {
  if (demo || !feeds) return [];
  const notices: BooksNotice[] = [];
  const active = feeds.connections.filter((c) => c.status === "active");
  const reconnect = feeds.connections.filter(
    (c) => c.status === "reconnect_required",
  );
  const unreviewed = feeds.identities.filter(
    (i) =>
      i.ownership === "unreviewed" &&
      !i.feed_account_id &&
      active.some((c) => c.id === i.connection_id),
  );
  const mapped = feeds.accounts.length;

  for (const connection of reconnect)
    notices.push({
      key: `reconnect:${connection.id}`,
      level: "critical",
      title: `Reconnect ${connection.name}`,
      detail:
        "The bank feed lost its access and nothing syncs until it is connected again with a new SimpleFIN token.",
      action: { label: "Bank feeds", onSelect: onFeeds },
    });

  if (unreviewed.length > 0 && mapped === 0) {
    const institutions = [
      ...new Set(unreviewed.map((i) => i.institution).filter(Boolean)),
    ];
    notices.push({
      key: "mapping",
      level: "critical",
      title: "Map your bank accounts to start syncing",
      detail: `${countLabel(unreviewed.length, "account was", "accounts were")} discovered${institutions.length ? ` from ${institutions.join(" and ")}` : ""}. Nothing is pulled in until each one is mapped to a book account, or marked personal or ignored.`,
      action: { label: "Map accounts", onSelect: onFeeds },
    });
  } else if (unreviewed.length > 0) {
    notices.push({
      key: "mapping-partial",
      level: "warning",
      title: `${countLabel(unreviewed.length, "discovered account still needs", "discovered accounts still need")} a decision`,
      detail:
        "They are not syncing. Map each one to a book account, or mark it personal or ignored.",
      action: { label: "Review accounts", onSelect: onFeeds },
    });
  }

  for (const connection of active) {
    const error = connection.last_error.trim();
    if (!error || error.startsWith(MAPPING_ERROR)) continue;
    notices.push({
      key: `sync:${connection.id}`,
      level: "warning",
      title: `${connection.name} could not finish its last sync`,
      detail: error,
      action: { label: "Bank feeds", onSelect: onFeeds },
    });
  }

  if (manage.preferences && manage.preferences.primary_system !== "admin")
    notices.push({
      key: "primary",
      level: "info",
      title: "Wave is still the system of record",
      detail:
        "Rules only fill drafts and never post while another system is primary. Switch when these books are ready to take over.",
      action: { label: "Book settings", onSelect: onSettings },
    });

  return notices;
}

const STYLE: Record<
  BooksNotice["level"],
  { box: string; icon: typeof Info; tone: string }
> = {
  critical: {
    box: "border-error/40 bg-error/5",
    icon: OctagonAlert,
    tone: "text-error",
  },
  warning: {
    box: "border-warning/40 bg-warning/5",
    icon: AlertTriangle,
    tone: "text-warning",
  },
  info: {
    box: "border-primary/30 bg-primary/5",
    icon: Info,
    tone: "text-teal-light",
  },
};

export function AccountingNotices({ notices }: { notices: BooksNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="space-y-2">
      {notices.map((n) => {
        const style = STYLE[n.level];
        const Icon = style.icon;
        return (
          <div
            key={n.key}
            role={n.level === "critical" ? "alert" : "status"}
            className={cn(
              "flex flex-wrap items-start gap-3 rounded-xl border px-4 py-3",
              style.box,
            )}
          >
            <Icon
              size={18}
              aria-hidden="true"
              className={cn("mt-0.5 shrink-0", style.tone)}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{n.title}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{n.detail}</p>
            </div>
            {n.action && (
              <Button
                size="sm"
                variant={n.level === "critical" ? "default" : "outline"}
                onClick={n.action.onSelect}
                className="shrink-0 self-center"
              >
                {n.action.label}
                <ArrowRight size={14} aria-hidden="true" />
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
