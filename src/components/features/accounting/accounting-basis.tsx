"use client";
import { AlertTriangle, Info } from "lucide-react";
import type { ReportData, ReportFilter } from "@/lib/accounting/reports";
import { Segmented } from "./report-kit";
import { dateLabel, money } from "./format";

export type Basis = NonNullable<ReportFilter["basis"]>;

export const basisLabel = (basis: string | undefined) =>
  basis === "accrual" ? "Accrual basis" : "Cash basis";

/** Cash or accrual. Shown once an invoice source has set the accrual start; the books themselves stay cash. */
export function BasisToggle({
  value,
  onChange,
}: {
  value: Basis;
  onChange: (basis: Basis) => void;
}) {
  return (
    <Segmented
      label="Basis"
      value={value}
      onChange={onChange}
      options={[
        { value: "cash", label: "Cash" },
        { value: "accrual", label: "Accrual" },
      ]}
    />
  );
}

/**
 * What the accrual figures rest on, said plainly so they are never silently
 * wrong: where they start, and every gap that would count money twice or
 * leave it out. Nothing shows on the cash basis.
 */
export function AccrualNotes({ data }: { data: ReportData | null }) {
  const q = data?.basis === "accrual" ? data.quality.accrual : undefined;
  if (!q) return null;
  const notes: { tone: "info" | "warning"; text: string }[] = [];
  if (q.partial && q.accrual_start)
    notes.push({
      tone: "info",
      text: `Accrual figures start on ${dateLabel(q.accrual_start)}. Earlier months show cash.`,
    });
  if (q.unlinked_client_deposits.count > 0)
    notes.push({
      tone: "warning",
      text: `${q.unlinked_client_deposits.count} client deposit${q.unlinked_client_deposits.count === 1 ? " is" : "s are"} not linked to an invoice (${money(q.unlinked_client_deposits.cents)}). Accrual income counts ${q.unlinked_client_deposits.count === 1 ? "it" : "them"} as cash received and may count ${q.unlinked_client_deposits.count === 1 ? "it" : "them"} twice. Link ${q.unlinked_client_deposits.count === 1 ? "it" : "them"} in Transactions.`,
    });
  if (q.paid_at_source_unlinked.count > 0)
    notes.push({
      tone: "warning",
      text: `${q.paid_at_source_unlinked.count} invoice${q.paid_at_source_unlinked.count === 1 ? " is" : "s are"} paid in your invoicing app but not linked to a deposit here, so ${money(q.paid_at_source_unlinked.cents)} still shows as owed.`,
    });
  if (q.unmapped_line_types.length > 0)
    notes.push({
      tone: "warning",
      text: `Choose revenue accounts for ${q.unmapped_line_types.join(", ")} lines in Manage, Invoice sources. Until then they count as uncategorized income.`,
    });
  if (q.unmapped_projects > 0)
    notes.push({
      tone: "warning",
      text: `${q.unmapped_projects} project${q.unmapped_projects === 1 ? " has" : "s have"} no client contact yet, so ${q.unmapped_projects === 1 ? "its" : "their"} income shows under no contact.`,
    });
  if (q.links_beyond_deposit > 0)
    notes.push({
      tone: "warning",
      text: `${q.links_beyond_deposit} deposit${q.links_beyond_deposit === 1 ? " is" : "s are"} linked for more than ${q.links_beyond_deposit === 1 ? "it credits" : "they credit"}. The difference still shows as owed.`,
    });
  if (q.stale_sources > 0)
    notes.push({
      tone: "warning",
      text: "Invoices last synced more than a day ago. Sync them in Manage, Invoice sources.",
    });
  if (q.changed_after_lock > 0)
    notes.push({
      tone: "warning",
      text: `${q.changed_after_lock} invoice${q.changed_after_lock === 1 ? "" : "s"} changed after ${q.changed_after_lock === 1 ? "its" : "their"} month was locked, so locked accrual figures may differ from today's.`,
    });
  if (!notes.length) return null;
  return (
    <section
      role="status"
      aria-label="About these accrual figures"
      className="glass-card space-y-2 rounded-xl p-4"
    >
      {notes.map((note) => (
        <p key={note.text} className="flex items-start gap-2 text-sm">
          {note.tone === "warning" ? (
            <AlertTriangle
              size={15}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-warning"
            />
          ) : (
            <Info
              size={15}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-muted-foreground"
            />
          )}
          <span
            className={note.tone === "warning" ? "" : "text-muted-foreground"}
          >
            {note.text}
          </span>
        </p>
      ))}
    </section>
  );
}
