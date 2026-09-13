"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useRef, useState } from "react";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { Select } from "@/components/ui/inputs/Select";
import { MaskedValue } from "@/components/ui/masked-value";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import { centsToDecimal, journalTotals } from "@/lib/accounting/money";
import { JournalTotals } from "./accounting-journal-totals";
import {
  registerActionLabels,
  type RegisterDetail,
  type RegisterAction,
  type RegisterPreview,
  type RegisterMovement,
} from "@/lib/accounting/registers";
import type { WorkflowCommand } from "@/lib/accounting/workflows";
import type { BooksMetadata } from "./types";
import {
  EvidencePicker,
  WorkflowActions,
  WorkflowDialog,
  usdCents,
  linkedEntry,
} from "./accounting-dialog";
import { AccountingPicker } from "./accounting-picker";
import { AccountingEntryPicker } from "./accounting-entry-picker";
import { absMoney, dateLabel } from "./format";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";

const AMOUNT_LABEL: Record<RegisterAction["kind"], string> = {
  acquisition: "Cost",
  depreciation: "Depreciation",
  disposal: "Net proceeds",
  payment: "Principal repaid",
  draw: "Principal received",
};
const COUNTER_LABEL: Record<RegisterAction["kind"], string> = {
  acquisition: "Paid from",
  depreciation: "",
  disposal: "Proceeds to",
  payment: "Paid from",
  draw: "Deposited to",
};

export function AccountingRegisterAction({
  record,
  kind,
  movement,
  proposal,
  accounts,
  manage,
  today,
  onSaved,
  onClose,
}: {
  record: RegisterDetail;
  kind: RegisterAction["kind"] | "void";
  movement?: RegisterMovement;
  proposal?: RegisterAction;
  accounts: AccountingAccount[];
  manage: BooksMetadata;
  today: string;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [id] = useState(() => crypto.randomUUID()),
    [date, setDate] = useState(
      movement?.mode === "historical"
        ? movement.effective_date
        : (proposal?.date ?? today),
    ),
    [amount, setAmount] = useState(
      proposal
        ? centsToDecimal(proposal.amount_cents)
        : kind === "acquisition"
          ? centsToDecimal(record.record.body.initial_cents)
          : "",
    ),
    [interest, setInterest] = useState(
      proposal?.interest_cents ? centsToDecimal(proposal.interest_cents) : "",
    ),
    [fee, setFee] = useState(
      proposal?.fee_cents ? centsToDecimal(proposal.fee_cents) : "",
    ),
    [counter, setCounter] = useState(""),
    [gain, setGain] = useState(""),
    [mode, setMode] = useState<"new" | "historical">("new"),
    [entry, setEntry] = useState(""),
    [doc, setDoc] = useState(record.record.document_id ?? ""),
    [reason, setReason] = useState(""),
    [preview, setPreview] = useState<RegisterPreview | null>(null),
    [reading, setReading] = useState(false),
    [error, setError] = useState("");
  const command = useAccountingCommand(onSaved),
    prepared = useRef<{ signature: string; command: WorkflowCommand } | null>(
      null,
    ),
    names = new Map(accounts.map((a) => [a.id, a.name]));
  const profiles = new Map(manage.profiles.map((p) => [p.account_id, p]));
  const options = (types: string[]) =>
    accounts
      .filter(
        (a) =>
          !a.is_archived &&
          types.includes(a.account_type) &&
          a.id !== record.record.body.account_id &&
          !(
            "accumulated_account_id" in record.record.body &&
            a.id === record.record.body.accumulated_account_id
          ) &&
          ![
            "uncategorized_income",
            "uncategorized_expense",
            "opening_balance_equity",
            "opening_retained_earnings",
          ].includes(profiles.get(a.id)?.purpose ?? ""),
      )
      .map((a) => ({
        value: a.id,
        label: a.name,
        group: a.account_type,
        keywords: a.code,
      }));
  function body(): RegisterAction {
    if (kind === "void") throw new Error("Choose a register action.");
    return {
      kind,
      date,
      ...(proposal?.schedule_row_key
        ? { schedule_row_key: proposal.schedule_row_key }
        : {}),
      amount_cents: usdCents(amount).toString(),
      ...(kind === "payment"
        ? {
            interest_cents: usdCents(interest).toString(),
            fee_cents: usdCents(fee).toString(),
          }
        : {}),
      ...(counter ? { counter_account_id: counter } : {}),
      ...(gain ? { gain_loss_account_id: gain } : {}),
    };
  }
  async function review() {
    setReading(true);
    setError("");
    try {
      setPreview(
        await accountingGet<RegisterPreview>({
          view: "register-preview",
          id: record.id,
          body: JSON.stringify(body()),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      if (kind === "void") {
        if (!movement) return;
        if (
          await command.execute({
            type: "register.void",
            id,
            register_id: record.id,
            expected_version: record.version,
            movement_id: movement.id,
            date,
            reason,
          })
        )
          onClose();
        return;
      }
      if (!preview) {
        await review();
        return;
      }
      if (!doc) throw new Error("Attach the source schedule or statement.");
      // The note is optional here; the command still needs one.
      const note = reason.trim() || "Recorded from the register";
      const b = body(),
        signature = JSON.stringify({ b, mode, entry, doc, note });
      if (prepared.current?.signature !== signature) {
        setReading(true);
        let linked;
        try {
          linked = mode === "historical" ? await linkedEntry(entry) : undefined;
        } finally {
          setReading(false);
        }
        prepared.current = {
          signature,
          command: {
            type: "register.post",
            id,
            register_id: record.id,
            expected_version: record.version,
            body: b,
            mode,
            document_id: doc,
            verified: true,
            reason: note,
            ...(linked
              ? { entry_id: linked.id, entry_version: linked.version }
              : {}),
          },
        };
      }
      if (await command.execute(prepared.current.command)) onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const isVoid = kind === "void",
    historical = movement?.mode === "historical",
    busy = reading || command.busy;
  const subject = movement
    ? registerActionLabels[movement.kind].replace("Record ", "")
    : "";
  const title = isVoid
    ? historical
      ? "Unlink entry"
      : "Reverse entry"
    : registerActionLabels[kind];
  const description =
    isVoid && movement
      ? `${subject[0].toUpperCase()}${subject.slice(1)}, ${dateLabel(movement.effective_date)}.`
      : undefined;
  return (
    <WorkflowDialog
      title={title}
      description={description}
      onClose={onClose}
      busy={busy}
      form
      size="sm"
    >
      <form className="space-y-5" onSubmit={save}>
        {isVoid ? (
          <fieldset className="space-y-5" disabled={busy}>
            <DateInput
              label="Entry date"
              required
              maxDate={today}
              readOnly={historical}
              value={date}
              onChange={(nextValue) => setDate(nextValue)}
            />
            <TextInput
              label="Reason"
              required
              maxLength={1000}
              value={reason}
              onChange={(nextValue) => setReason(nextValue)}
            />
          </fieldset>
        ) : (
          <>
            <fieldset
              className="space-y-5"
              disabled={busy}
              onChange={() => setPreview(null)}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <DateInput
                  label="Entry date"
                  required
                  maxDate={today}
                  value={date}
                  onChange={(nextValue) => setDate(nextValue)}
                />
                <TextInput
                  label={AMOUNT_LABEL[kind]}
                  inputMode="decimal"
                  placeholder="0.00"
                  required
                  value={amount}
                  onChange={(nextValue) => setAmount(nextValue)}
                />
              </div>
              {kind === "payment" && (
                <TextInput
                  label="Interest"
                  inputMode="decimal"
                  placeholder="0.00"
                  description="From the lender statement"
                  value={interest}
                  onChange={(nextValue) => setInterest(nextValue)}
                />
              )}
              {kind !== "depreciation" && (
                <AccountingPicker
                  label={COUNTER_LABEL[kind]}
                  visibleLabel={COUNTER_LABEL[kind]}
                  value={counter}
                  options={options(["asset", "liability", "equity"])}
                  onChange={(v) => {
                    setCounter(v);
                    setPreview(null);
                  }}
                  placeholder="Choose an account"
                />
              )}
              {kind === "disposal" && (
                <AccountingPicker
                  label="Gain or loss account"
                  visibleLabel="Gain or loss account"
                  value={gain}
                  options={options(["income", "expense"])}
                  onChange={(v) => {
                    setGain(v);
                    setPreview(null);
                  }}
                  placeholder="Income for a gain, expense for a loss"
                />
              )}
            </fieldset>
            <EvidencePicker value={doc} onChange={setDoc} required />
            <details className="group rounded-xl border border-border">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground group-open:text-foreground">
                Advanced
              </summary>
              <fieldset
                className="space-y-4 border-t border-border p-4"
                disabled={busy}
              >
                <Select
                  label="Entry source"
                  value={mode}
                  onChange={(v) => {
                    setMode(v as "new" | "historical");
                    setPreview(null);
                  }}
                  options={[
                    { value: "new", label: "New journal entry" },
                    {
                      value: "historical",
                      label: "Link an existing transaction",
                    },
                  ]}
                />
                {mode === "historical" && (
                  <AccountingEntryPicker
                    value={entry}
                    onChange={(v) => {
                      setEntry(v);
                      setPreview(null);
                    }}
                  />
                )}
                {kind === "payment" && (
                  <TextInput
                    label="Loan fees"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={fee}
                    onChange={(nextValue) => {
                      setFee(nextValue);
                      setPreview(null);
                    }}
                  />
                )}
                <TextInput
                  label="Notes"
                  maxLength={1000}
                  placeholder="Optional"
                  value={reason}
                  onChange={(nextValue) => setReason(nextValue)}
                />
              </fieldset>
            </details>
            {preview && (
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Proposed journal
                </p>
                <div className="divide-y divide-border rounded-xl border border-border">
                  {[...preview.lines]
                    .sort(
                      (a, b) =>
                        Number(BigInt(b.amount_cents) > BigInt(0)) -
                        Number(BigInt(a.amount_cents) > BigInt(0)),
                    )
                    .map((l) => (
                      <div
                        key={l.account_id}
                        className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm"
                      >
                        <span className="min-w-0 truncate">
                          {names.get(l.account_id)}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {BigInt(l.amount_cents) > BigInt(0)
                              ? "Debit"
                              : "Credit"}
                          </span>
                          <MaskedValue
                            value={absMoney(l.amount_cents)}
                            className="tabular-nums"
                          />
                        </span>
                      </div>
                    ))}
                </div>
                <JournalTotals {...journalTotals(preview.lines)} />
              </div>
            )}
          </>
        )}
        {isVoid ? (
          <div className="sticky -bottom-5 z-10 -mx-6 -mb-5 space-y-3 border-t border-border bg-[var(--background-subtle)] px-6 py-4">
            {(error || command.error) && (
              <p role="alert" className="text-sm text-error">
                {error || command.error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="ghost" disabled={busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="destructive" disabled={busy}>
                {command.busy ? "Saving..." : historical ? "Unlink" : "Reverse"}
              </Button>
            </div>
          </div>
        ) : (
          <WorkflowActions
            busy={busy}
            error={error || command.error}
            label={
              preview ? (mode === "historical" ? "Link" : "Post") : "Preview"
            }
            onClose={onClose}
          />
        )}
      </form>
    </WorkflowDialog>
  );
}
