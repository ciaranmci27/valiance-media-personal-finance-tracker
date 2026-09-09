"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useRef, useState } from "react";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { Select } from "@/components/ui/inputs/Select";
import { MaskedValue } from "@/components/ui/masked-value";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import { centsToDecimal } from "@/lib/accounting/money";
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
  InvoiceDialog,
  InvoiceEvidence,
  InvoiceActions,
  usdCents,
  invoiceLinkedEntry,
} from "./accounting-dialog";
import { AccountingPicker } from "./accounting-picker";
import { AccountingEntryPicker } from "./accounting-entry-picker";
import { absMoney } from "./format";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
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
    [verified, setVerified] = useState(false),
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
    setVerified(false);
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
      if (!verified)
        throw new Error(
          "Confirm the source and proposed journal before continuing.",
        );
      if (!doc) throw new Error("Attach the source schedule or statement.");
      const b = body(),
        signature = JSON.stringify({ b, mode, entry, doc, reason });
      if (prepared.current?.signature !== signature) {
        setReading(true);
        let linked;
        try {
          linked =
            mode === "historical" ? await invoiceLinkedEntry(entry) : undefined;
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
            reason,
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
    title = isVoid
      ? movement?.mode === "historical"
        ? "Unlink historical entry"
        : "Reverse register entry"
      : registerActionLabels[kind];
  return (
    <InvoiceDialog
      title={title}
      description={record.record.body.name}
      onClose={onClose}
      busy={reading || command.busy}
    >
      <form className="space-y-5" onSubmit={save}>
        <fieldset
          className="space-y-4"
          disabled={reading || command.busy}
          onChange={() => {
            setPreview(null);
            setVerified(false);
          }}
        >
          {isVoid ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {movement?.mode === "historical"
                ? "Remove this register allocation on its original date. The journal stays in the books."
                : "Create an equal and opposite entry. The original journal and register history are retained. Dependent depreciation, disposals or payments must remain valid."}
            </p>
          ) : (
            <Select
              label="Entry source"
              value={mode}
              onChange={(v) => {
                setMode(v as "new" | "historical");
                setPreview(null);
                setVerified(false);
              }}
              options={[
                { value: "new", label: "Create a new reviewed journal" },
                {
                  value: "historical",
                  label: "Link an existing reviewed transaction",
                },
              ]}
            />
          )}
          <DateInput
            label="Entry date"
            required
            maxDate={today}
            readOnly={isVoid && movement?.mode === "historical"}
            value={date}
            onChange={(nextValue) => setDate(nextValue)}
          />
          {!isVoid && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextInput
                  label={
                    kind === "acquisition"
                      ? "Acquisition cost"
                      : kind === "depreciation"
                        ? "Book depreciation"
                        : kind === "disposal"
                          ? "Net disposal proceeds"
                          : kind === "payment"
                            ? "Principal repaid"
                            : "Principal received"
                  }
                  inputMode="decimal"
                  required
                  value={amount}
                  onChange={(nextValue) => setAmount(nextValue)}
                />
                {kind === "payment" && (
                  <>
                    <TextInput
                      label="Interest from lender statement"
                      inputMode="decimal"
                      value={interest}
                      onChange={(nextValue) => setInterest(nextValue)}
                    />
                    <TextInput
                      label="Documented loan fees"
                      inputMode="decimal"
                      value={fee}
                      onChange={(nextValue) => setFee(nextValue)}
                    />
                  </>
                )}
              </div>
              {kind !== "depreciation" && (
                <AccountingPicker
                  label={
                    kind === "acquisition"
                      ? "Paid from or financed by"
                      : kind === "payment"
                        ? "Payment account"
                        : "Proceeds account"
                  }
                  value={counter}
                  options={options(["asset", "liability", "equity"])}
                  onChange={(v) => {
                    setCounter(v);
                    setPreview(null);
                    setVerified(false);
                  }}
                  placeholder="Choose the offset account"
                />
              )}
              {kind === "disposal" && (
                <AccountingPicker
                  label="Book gain or loss account"
                  value={gain}
                  options={options(["income", "expense"])}
                  onChange={(v) => {
                    setGain(v);
                    setPreview(null);
                    setVerified(false);
                  }}
                  placeholder="Choose income for a gain or expense for a loss"
                />
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                {kind === "depreciation"
                  ? "Use the approved book schedule. This does not calculate tax depreciation or elect a deduction."
                  : kind === "payment"
                    ? "Enter the lender statement split. Principal reduces the loan; interest and fees are separate expenses."
                    : kind === "disposal"
                      ? "The preview removes recorded cost and accumulated depreciation and calculates the book gain or loss from net proceeds. Tax treatment is reviewed separately."
                      : mode === "historical"
                        ? "Each proposed amount must fit the existing transaction. A shared purchase can be allocated across assets without posting it again."
                        : "Review the proposed journal against the original purchase or loan evidence."}
              </p>
              {mode === "historical" && (
                <AccountingEntryPicker
                  value={entry}
                  onChange={(v) => {
                    setEntry(v);
                    setPreview(null);
                    setVerified(false);
                  }}
                />
              )}
            </>
          )}
        </fieldset>
        {!isVoid && (
          <>
            <InvoiceEvidence value={doc} onChange={setDoc} required />
            {preview && (
              <div className="rounded-xl border border-border p-4">
                <p className="mb-3 text-sm font-medium">Proposed journal</p>
                <div className="divide-y divide-border">
                  {[...preview.lines]
                    .sort(
                      (a, b) =>
                        Number(BigInt(b.amount_cents) > BigInt(0)) -
                        Number(BigInt(a.amount_cents) > BigInt(0)),
                    )
                    .map((l) => (
                      <div
                        key={l.account_id}
                        className="flex items-center justify-between gap-4 py-2 text-sm"
                      >
                        <span>{names.get(l.account_id)}</span>
                        <span className="flex items-center gap-2">
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
                <Checkbox
                  className="mt-4"
                  checked={verified}
                  onChange={setVerified}
                  disabled={command.busy}
                  label="I verified this journal against the source document."
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPreview(null);
                    setVerified(false);
                  }}
                  disabled={command.busy}
                >
                  Revise entry
                </Button>
              </div>
            )}
          </>
        )}
        <TextInput
          label="Reason and verification"
          required
          maxLength={1000}
          value={reason}
          onChange={(nextValue) => setReason(nextValue)}
          disabled={command.busy}
        />
        <InvoiceActions
          busy={reading || command.busy}
          error={error || command.error}
          label={
            isVoid
              ? title
              : preview
                ? mode === "historical"
                  ? "Link reviewed transaction"
                  : "Post reviewed journal"
                : "Preview journal"
          }
          onClose={onClose}
        />
      </form>
    </InvoiceDialog>
  );
}
