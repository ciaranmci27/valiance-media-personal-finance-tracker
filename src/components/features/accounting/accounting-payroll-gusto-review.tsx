"use client";
import Link from "next/link";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { RadioGroup } from "@/components/ui/inputs/RadioGroup";
import { MaskedValue } from "@/components/ui/masked-value";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { GustoFeeRow, GustoState } from "@/lib/accounting/gusto-import";
import {
  correctChoice,
  gustoFeeSummary,
  linkChoice,
  type GustoSummary,
  type GustoUnit,
} from "@/lib/accounting/gusto-review";
import { absMoney, dateLabel, money, signedMoney } from "./format";

/** books minus Gusto, said from Gusto's side: "$0.01 lower" when Gusto is less. */
const gustoVsBooks = (booksMinusGusto: string) => {
  const cents = BigInt(booksMinusGusto);
  return cents === BigInt(0)
    ? "Same"
    : `${absMoney(cents)} ${cents > BigInt(0) ? "lower" : "higher"}`;
};

const monthName = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const monthLabel = (month: string) =>
  monthName.format(new Date(`${month}-01T00:00:00Z`));

const STATUS: Record<GustoState, { label: string; variant: BadgeVariant }> = {
  match: { label: "Linked", variant: "success" },
  date_match: { label: "Linked", variant: "success" },
  group_match: { label: "Linked", variant: "success" },
  difference: { label: "Difference", variant: "warning" },
  duplicate: { label: "Already imported", variant: "default" },
  conflict: { label: "Conflict", variant: "danger" },
  new: { label: "New", variant: "info" },
};

const count = (n: number) =>
  n === 2 ? "Two" : n === 3 ? "Three" : n === 4 ? "Four" : String(n);

/** The plain sentence under each payroll or group. */
function statusLine(unit: GustoUnit): string {
  const first = unit.runs[0];
  const n = unit.runs.length;
  switch (unit.state) {
    case "match":
      return "In your books on the same day with the same amounts. It will be linked, nothing is added.";
    case "date_match":
      return `In your books with the same amounts, dated ${dateLabel(first.entry?.entry_date)}. Keep the books' date or move it to the pay date.`;
    case "group_match":
      return `${count(n)} payrolls on one monthly entry in your books, with the same amounts. They will be linked together, nothing is added.`;
    case "difference":
      return n > 1
        ? `${count(n)} payrolls on one monthly entry in your books, with different amounts.`
        : "In your books with different amounts.";
    case "duplicate":
      return "Already imported. Nothing will change.";
    case "conflict":
      return `${first.message} This payroll is skipped.`;
    default:
      return "Not in your books yet. Importing posts a payroll entry on the pay date.";
  }
}

function paydays(unit: GustoUnit) {
  const dates = unit.runs.map((r) => r.pay_date);
  return dates.length === 1
    ? `Payday ${dateLabel(dates[0])}`
    : `Paydays ${dates.map((d) => dateLabel(d)).join(" and ")}`;
}

export function GustoSummaryTiles({ summary }: { summary: GustoSummary }) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded-xl bg-secondary/40 p-4 text-center sm:grid-cols-5">
      {(
        [
          ["Payrolls", summary.payrolls],
          ["Will link", summary.link],
          ["Need a choice", summary.needChoice],
          ["New", summary.posted],
          ["Skipped", summary.skipped],
        ] as const
      ).map(([label, total]) => (
        <div
          key={label}
          className={
            label === "Payrolls" ? "col-span-2 sm:col-span-1" : undefined
          }
        >
          <p
            className={`text-xl font-semibold tabular-nums ${label === "Need a choice" && total > 0 ? "text-warning" : ""}`}
          >
            {total}
          </p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      ))}
    </div>
  );
}

export function GustoReview({
  units,
  choices,
  onChoose,
  accounts,
  busy,
}: {
  units: GustoUnit[];
  choices: Record<string, string>;
  onChoose: (unit: string, choice: string | null) => void;
  accounts: AccountingAccount[];
  busy: boolean;
}) {
  const months = [...new Set(units.map((u) => u.month))];
  const accountName = (id: string) =>
    accounts.find((a) => a.id === id)?.name ?? "Account";
  return (
    <div className="space-y-6">
      {months.map((month) => (
        <section key={month} aria-labelledby={`gusto-${month}`}>
          <h4
            id={`gusto-${month}`}
            className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {monthLabel(month)}
          </h4>
          <div className="space-y-3">
            {units
              .filter((u) => u.month === month)
              .map((unit) => {
                const first = unit.runs[0];
                const entry = first.entry;
                const status = STATUS[unit.state];
                const cost = unit.runs.reduce(
                  (t, r) => t + BigInt(r.gross) + BigInt(r.employer_tax),
                  BigInt(0),
                );
                const choice = choices[unit.key] ?? "";
                return (
                  <article
                    key={unit.key}
                    className={`rounded-xl border p-4 ${unit.state === "duplicate" || unit.state === "conflict" ? "border-border bg-secondary/30" : unit.state === "difference" || (unit.state === "date_match" && !choice) ? "border-warning/40 bg-background" : "border-border bg-background"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h5 className="font-semibold">{paydays(unit)}</h5>
                          <Badge variant={status.variant} dot>
                            {status.label}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {dateLabel(first.period_from)} to{" "}
                          {dateLabel(unit.runs[unit.runs.length - 1].period_to)}
                          {" · "}
                          {first.employee_count}{" "}
                          {first.employee_count === 1
                            ? "employee"
                            : "employees"}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <MaskedValue
                          value={money(cost)}
                          className="font-semibold tabular-nums"
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                          Payroll cost
                        </p>
                      </div>
                    </div>
                    <p
                      className={`mt-3 text-sm ${unit.state === "conflict" ? "text-warning" : "text-muted-foreground"}`}
                    >
                      {statusLine(unit)}
                    </p>
                    {entry && unit.state !== "conflict" && (
                      <Link
                        href={`/accounting?view=journal&entry=${entry.id}`}
                        className="mt-2 inline-flex text-sm font-medium underline underline-offset-4"
                      >
                        Open {entry.memo || "the entry"} (
                        {dateLabel(entry.entry_date)})
                      </Link>
                    )}
                    {unit.state === "difference" && (
                      <div className="mt-3 overflow-x-auto">
                        <table className="w-full text-xs">
                          <caption className="sr-only">
                            Amounts that differ between Gusto and your books
                          </caption>
                          <thead>
                            <tr className="text-muted-foreground">
                              <th
                                scope="col"
                                className="py-2 text-left font-medium"
                              >
                                Account
                              </th>
                              <th
                                scope="col"
                                className="px-2 text-right font-medium"
                              >
                                Gusto
                              </th>
                              <th
                                scope="col"
                                className="px-2 text-right font-medium"
                              >
                                Your books
                              </th>
                              <th
                                scope="col"
                                className="text-right font-medium"
                              >
                                Gusto vs books
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {first.difference.map((d) => (
                              <tr
                                key={d.account_id}
                                className="border-t border-border"
                              >
                                <th
                                  scope="row"
                                  className="py-2 text-left font-normal"
                                >
                                  {accountName(d.account_id)}
                                </th>
                                <td className="px-2 text-right tabular-nums">
                                  <MaskedValue value={money(d.gusto_cents)} />
                                </td>
                                <td className="px-2 text-right tabular-nums">
                                  <MaskedValue value={money(d.books_cents)} />
                                </td>
                                <td className="text-right tabular-nums text-warning">
                                  <MaskedValue
                                    value={gustoVsBooks(d.difference_cents)}
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {unit.state === "difference" && entry && (
                      <RadioGroup
                        className="mt-4"
                        label="What should happen?"
                        name={`gusto-${unit.key}`}
                        value={choice}
                        disabled={busy}
                        onChange={(value) => onChoose(unit.key, value)}
                        options={[
                          {
                            value: correctChoice(unit),
                            label: "Correct to Gusto",
                            description: entry.can_correct
                              ? "Your entry is replaced with Gusto's amounts on the same date. Gusto's figures are the ones your W-2s use."
                              : "Not available: this entry is in a locked month or tied to bank or reconciliation records.",
                            disabled: !entry.can_correct,
                          },
                          {
                            value: linkChoice(unit),
                            label: "Keep my books",
                            description:
                              "The payroll links to your entry as it is, and the difference stays noted on the payroll.",
                          },
                        ]}
                      />
                    )}
                    {unit.state === "date_match" && entry && (
                      <RadioGroup
                        className="mt-4"
                        label="Which date should the books use?"
                        name={`gusto-${unit.key}`}
                        value={choice}
                        disabled={busy}
                        onChange={(value) => onChoose(unit.key, value)}
                        options={[
                          {
                            value: linkChoice(unit),
                            label: `Keep the books' date, ${dateLabel(entry.entry_date)}`,
                          },
                          {
                            value: correctChoice(unit),
                            label: `Move it to the pay date, ${dateLabel(first.pay_date)}`,
                            description: entry.can_correct
                              ? undefined
                              : "Not available: this entry is in a locked month or tied to bank or reconciliation records.",
                            disabled: !entry.can_correct,
                          },
                        ]}
                      />
                    )}
                    {unit.state === "new" && (
                      <Checkbox
                        className="mt-3"
                        label="Record this payroll"
                        checked={choice === "new"}
                        disabled={busy}
                        onChange={(checked) =>
                          onChoose(unit.key, checked ? "new" : null)
                        }
                      />
                    )}
                    <details className="mt-3 text-sm">
                      <summary className="cursor-pointer text-muted-foreground">
                        Payroll breakdown
                      </summary>
                      <div className="my-3 space-y-3">
                        {unit.runs.map((r) => (
                          <div key={r.key}>
                            {unit.runs.length > 1 && (
                              <p className="mb-2 text-xs font-medium">
                                Payday {dateLabel(r.pay_date)}
                              </p>
                            )}
                            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                              {(
                                [
                                  ["Gross wages", r.gross],
                                  ["Employee taxes", r.employee_tax],
                                  ["Employer taxes", r.employer_tax],
                                  ["Take-home pay", r.net],
                                ] as const
                              ).map(([label, value]) => (
                                <div key={label}>
                                  <dt className="text-xs text-muted-foreground">
                                    {label}
                                  </dt>
                                  <dd className="mt-1 tabular-nums">
                                    <MaskedValue value={money(value)} />
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </div>
                        ))}
                      </div>
                    </details>
                  </article>
                );
              })}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Gusto's fee withdrawals and refund deposits already in the books on another
 * category. Each can move to the payroll account it belongs on; the date, the
 * bank line and any bank match stay as they are.
 */
export function GustoFees({
  rows,
  selected,
  onToggle,
  onAll,
  accountName,
  busy,
}: {
  rows: GustoFeeRow[];
  selected: ReadonlySet<string>;
  onToggle: (id: string, checked: boolean) => void;
  onAll: (checked: boolean) => void;
  accountName: (id: string) => string;
  busy: boolean;
}) {
  if (!rows.length) return null;
  const movable = rows.filter((r) => !r.blocked && r.to_account_id);
  const allChosen =
    movable.length > 0 && movable.every((r) => selected.has(r.id));
  const summary = gustoFeeSummary(rows, selected, accountName, money);
  return (
    <section aria-labelledby="gusto-fees" className="space-y-3">
      <div>
        <h4 id="gusto-fees" className="font-semibold">
          Gusto fees and refunds in your books
        </h4>
        <p className="mt-1 text-sm text-muted-foreground">
          {summary || "Nothing selected. These entries stay where they are."}
        </p>
      </div>
      {movable.length > 1 && (
        <Checkbox
          label={`Move all ${movable.length}`}
          checked={allChosen}
          disabled={busy}
          onChange={(checked) => onAll(checked)}
        />
      )}
      <ul className="divide-y divide-border rounded-xl border border-border bg-background">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-start justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0">
              <Checkbox
                label={`${dateLabel(row.entry_date)} · ${row.memo || "Gusto"}`}
                description={
                  row.blocked
                    ? accountName(row.from_account_id)
                    : `${accountName(row.from_account_id)} to ${row.to_account_id ? accountName(row.to_account_id) : "a payroll fees account"}`
                }
                checked={selected.has(row.id)}
                disabled={busy || !!row.blocked || !row.to_account_id}
                onChange={(checked) => onToggle(row.id, checked)}
              />
              {row.blocked && (
                <p className="ml-7 mt-1 text-xs text-muted-foreground">
                  Stays as it is: {row.blocked}
                </p>
              )}
            </div>
            <MaskedValue
              value={signedMoney(row.amount_cents)}
              className="shrink-0 text-sm tabular-nums"
            />
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Each entry keeps its date and bank line; only its category changes.
        Undoing a payroll import later does not move these back.
      </p>
    </section>
  );
}
