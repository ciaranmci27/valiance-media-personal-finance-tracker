"use client";
import { useState } from "react";
import { FileCheck2, Link2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/inputs/Select";
import { TextInput } from "@/components/ui/inputs/TextInput";
import type { JournalEntry } from "@/lib/accounting/contracts";
import { centsToDecimal, parseUsd } from "@/lib/accounting/money";
import {
  SUGGESTION_REASONS,
  invoiceChipLabel,
  linkStateLabel,
  type ReceivablesView,
} from "@/lib/accounting/receivables";
import { cn } from "@/lib/utils";
import { dateLabel, money } from "./format";
import { useAccountingCommand } from "./use-accounting-command";
import { useAccountingRead } from "./use-accounting-read";

/** Tells the invoicing app about a link made or ended here; the hourly sync catches anything this misses. */
function pushInvoices() {
  void fetch("/api/accounting/invoice-sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "push" }),
  }).catch(() => undefined);
}

/**
 * A deposit's invoices in the transaction editor: the ones it pays, the one
 * it looks like it pays, and a way to link another (or part of one). Linking
 * never changes the transaction; it only records which invoice this money
 * paid, and the invoicing app marks it paid.
 */
export function EntryInvoices({
  entry,
  bankLineId,
  demo,
  onSaved,
}: {
  entry: JournalEntry;
  /** The entry's one bank or cash line; money into it is what can pay an invoice. */
  bankLineId: string | null;
  demo: boolean;
  onSaved: () => Promise<void>;
}) {
  const links = entry.invoice_links ?? [];
  const suggestion = entry.invoice_suggestion ?? null;
  const [choosing, setChoosing] = useState(false);
  const [invoiceId, setInvoiceId] = useState(""),
    [amount, setAmount] = useState("");
  const [ending, setEnding] = useState<string | null>(null),
    [reason, setReason] = useState("");
  const open = useAccountingRead<ReceivablesView>(
    { view: "receivables", status: "open", limit: "200" },
    { enabled: choosing && !demo },
  );
  const command = useAccountingCommand(async () => {
    pushInvoices();
    await onSaved();
  });
  // What this deposit can still apply: its credit lines less the links that count.
  const bank = entry.lines.find((l) => l.id === bankLineId);
  const credits = entry.lines.reduce(
    (sum, l) =>
      l.id !== bankLineId && BigInt(l.amount_cents) < BigInt(0)
        ? sum - BigInt(l.amount_cents)
        : sum,
    BigInt(0),
  );
  const linked = links
    .filter((l) => l.live)
    .reduce((sum, l) => sum + BigInt(l.amount_cents), BigInt(0));
  const remaining = suggestion
    ? BigInt(suggestion.remaining_cents)
    : credits - linked;
  const deposit =
    !!bank &&
    BigInt(bank.amount_cents) > BigInt(0) &&
    entry.status !== "discarded" &&
    !entry.reversed_by_entry_id &&
    !entry.transfer_group_id &&
    !entry.pair_entry_id;
  if (!links.length && !suggestion && (!deposit || remaining <= BigInt(0)))
    return null;

  const invoices = (open.data?.invoices ?? []).filter(
    (i) => !links.some((l) => l.live && l.invoice_id === i.id),
  );
  const chosen = invoices.find((i) => i.id === invoiceId);
  let cents: bigint | null = null;
  try {
    cents = amount ? BigInt(parseUsd(amount)) : null;
  } catch {
    cents = null;
  }
  const amountError =
    amount && (cents === null || cents <= BigInt(0))
      ? "Enter an amount above zero."
      : cents !== null && chosen && cents > BigInt(chosen.outstanding_cents)
        ? "That is more than the invoice still owes."
        : cents !== null && cents > remaining
          ? "That is more than this deposit has left."
          : undefined;

  function link(allocations: { invoice_id: string; amount_cents: string }[]) {
    return command.execute({
      type: "invoice.link",
      id: crypto.randomUUID(),
      entry_id: entry.id,
      expected_version: entry.version,
      allocations,
    });
  }

  return (
    <section
      className="mt-6 space-y-2"
      aria-labelledby={`invoices-${entry.id}`}
    >
      <div className="flex items-center justify-between px-1">
        <h3
          id={`invoices-${entry.id}`}
          className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
        >
          Invoices
        </h3>
        {deposit && remaining > BigInt(0) && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {money(remaining)} not linked
          </span>
        )}
      </div>
      {links.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {links.map((l) => (
            <li key={l.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <FileCheck2
                    size={15}
                    aria-hidden="true"
                    className={cn(
                      "shrink-0",
                      l.sync_state === "failed" || !l.live
                        ? "text-warning"
                        : "text-teal-light",
                    )}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {l.number || "Invoice"}{" "}
                      <span className="font-normal text-muted-foreground">
                        {l.project_name}
                      </span>
                    </p>
                    <p
                      className={cn(
                        "text-xs",
                        l.sync_state === "failed" || !l.live
                          ? "text-warning"
                          : "text-muted-foreground",
                      )}
                    >
                      {money(l.amount_cents)} · {linkStateLabel(l)}
                      {l.matched_by === "rule" && " · matched automatically"}
                      {l.sync_state === "failed" &&
                        l.last_error &&
                        `. ${l.last_error}`}
                    </p>
                  </div>
                </div>
                {ending !== l.id && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={demo || command.busy}
                    onClick={() => {
                      setEnding(l.id);
                      setReason("");
                    }}
                  >
                    <Unlink aria-hidden="true" />
                    Unlink
                  </Button>
                )}
              </div>
              {ending === l.id && (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void command
                      .execute({
                        type: "invoice.unlink",
                        id: l.id,
                        expected_version: l.version,
                        reason: reason.trim(),
                      })
                      .then((saved) => {
                        if (saved) setEnding(null);
                      });
                  }}
                >
                  <TextInput
                    className="min-w-0 flex-1"
                    label="Why unlink?"
                    placeholder="For example: wrong invoice"
                    value={reason}
                    maxLength={1000}
                    required
                    onChange={setReason}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setEnding(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={!reason.trim() || command.busy}
                    loading={command.busy}
                  >
                    Unlink
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {suggestion && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-teal-light/40 p-3">
          <p className="min-w-0 text-sm">
            Looks like{" "}
            {invoiceChipLabel(suggestion.invoices.map((i) => i.number))}{" "}
            <span className="text-muted-foreground">
              ({SUGGESTION_REASONS[suggestion.reason]}
              {suggestion.ambiguous ? ", the oldest of several" : ""})
            </span>
          </p>
          <Button
            type="button"
            size="sm"
            disabled={demo || command.busy}
            onClick={() =>
              void link(
                suggestion.invoices.map((i) => ({
                  invoice_id: i.invoice_id,
                  amount_cents: i.amount_cents,
                })),
              )
            }
          >
            <Link2 aria-hidden="true" />
            Link
          </Button>
        </div>
      )}
      {deposit && remaining > BigInt(0) && !choosing && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={demo}
          onClick={() => setChoosing(true)}
        >
          <Link2 aria-hidden="true" />
          {links.length || suggestion
            ? "Link another invoice"
            : "Link an invoice"}
        </Button>
      )}
      {choosing && (
        <form
          className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!chosen || cents === null || amountError) return;
            void link([
              { invoice_id: chosen.id, amount_cents: cents.toString() },
            ]).then((saved) => {
              if (saved) {
                setChoosing(false);
                setInvoiceId("");
                setAmount("");
              }
            });
          }}
        >
          <Select
            label="Invoice"
            searchable
            visibleLabel="Invoice"
            value={invoiceId}
            placeholder={
              open.loading ? "Loading open invoices" : "Choose an open invoice"
            }
            emptyText="No open invoices"
            options={invoices.map((i) => ({
              value: i.id,
              label: `${i.number || "Invoice"} ${i.project_name}`,
              detail: `${money(i.outstanding_cents)} owed · ${dateLabel(i.issue_date)}`,
              keywords: `${i.customer_name} ${i.party_name ?? ""}`,
            }))}
            onChange={(value) => {
              setInvoiceId(value);
              const next = invoices.find((i) => i.id === value);
              if (next) {
                const owed = BigInt(next.outstanding_cents);
                setAmount(centsToDecimal(owed < remaining ? owed : remaining));
              }
            }}
          />
          <TextInput
            label="Amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={setAmount}
            error={amountError}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setChoosing(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                !chosen || cents === null || !!amountError || command.busy
              }
              loading={command.busy}
            >
              Link
            </Button>
          </div>
          {open.error && (
            <p role="alert" className="text-sm text-error sm:col-span-3">
              {open.error}
            </p>
          )}
        </form>
      )}
      {command.error && (
        <p role="alert" className="text-sm text-error">
          {command.error}
        </p>
      )}
    </section>
  );
}
