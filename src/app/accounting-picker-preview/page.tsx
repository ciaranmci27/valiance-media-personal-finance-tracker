"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PrivacyProvider } from "@/contexts/privacy-context";
import { DataTable } from "@/components/ui/data-table";
import { AccountingCategoryPicker } from "@/components/features/accounting/accounting-category-picker";
import { AccountingTransferFromDraft } from "@/components/features/accounting/accounting-transfer-from-draft";
import { AccountingTransactionEditor } from "@/components/features/accounting/accounting-transaction-editor";
import {
  JournalEditorDialog,
  makeEditor,
  type Editor,
} from "@/components/features/accounting/accounting-journal-dialogs";
import {
  categoryGroups,
  categoryMenu,
} from "@/lib/accounting/categories";
import type {
  AccountingAccount,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type { AccountProfile } from "@/lib/accounting/workflows";

/** Temporary visual check for the category picker and the transfer dialog; synthetic chart, no books. */
const seeds: [string, string, string, AccountingAccount["account_type"], string, string | null][] = [
  ["checking", "1000", "AMEX Agency Checking -6491", "asset", "bank", "checking"],
  ["card", "2100", "CIARAN D MCINTYRE -2005", "liability", "card", "business_card"],
  ["receivable", "1300", "Accounts receivable", "asset", "receivable", null],
  ["equipment", "1500", "Equipment", "asset", "fixed_asset", null],
  ["loan", "2600", "Loans payable", "liability", "loan", null],
  ["payroll", "2400", "Payroll taxes payable", "liability", "payroll_liability", null],
  ["contrib", "3100", "Shareholder contributions", "equity", "owner_equity", "contributions"],
  ["distrib", "3200", "Shareholder distributions", "equity", "owner_equity", "distributions"],
  ["sales", "4000", "Agency income", "income", "revenue", null],
  ["saas", "4100", "SaaS income", "income", "revenue", null],
  ["interest", "4300", "Interest income", "income", "other", null],
  ["uncat_in", "4900", "Uncategorized income", "income", "uncategorized", "uncategorized_income"],
  ["ads", "6000", "Advertising & promotion", "expense", "operating_expense", null],
  ["bank_fees", "6010", "Bank service charges", "expense", "operating_expense", null],
  ["hardware", "6100", "Computer hardware", "expense", "operating_expense", null],
  ["hosting", "6110", "Computer hosting", "expense", "operating_expense", null],
  ["software", "6120", "Computer software", "expense", "operating_expense", null],
  ["meals", "6200", "Meals", "expense", "operating_expense", null],
  ["uncat_out", "6990", "Uncategorized expense", "expense", "uncategorized", "uncategorized_expense"],
];
const accounts: AccountingAccount[] = seeds.map(([id, code, name, account_type]) => ({
  id,
  code,
  name,
  account_type,
  normal_side: account_type === "asset" || account_type === "expense" ? "debit" : "credit",
  is_archived: false,
}));
const profiles: AccountProfile[] = seeds.map(([id, , , , subtype, purpose]) => ({
  account_id: id,
  version: 1,
  purpose,
  cash_kind: subtype === "bank" || subtype === "card" ? subtype : "none",
  parent_account_id: null,
  subtype,
}));
const draft = (
  id: string,
  memo: string,
  date: string,
  bank: string,
  cents: string,
): JournalEntry => ({
  id,
  entry_date: date,
  memo,
  status: "draft",
  version: 1,
  primary_origin: "simplefin",
  source_description: memo,
  descriptor_key: null,
  prior_treatment: null,
  reverses_entry_id: null,
  reversed_by_entry_id: null,
  created_at: `${date}T00:00:00Z`,
  lines: [
    { id: `${id}-bank`, account_id: bank, amount_cents: cents, memo: "" },
    {
      id: `${id}-cat`,
      account_id: cents.startsWith("-") ? "uncat_out" : "uncat_in",
      amount_cents: cents.startsWith("-") ? cents.slice(1) : `-${cents}`,
      memo: "",
    },
  ],
});
const debit = draft(
  "e1",
  "Online Transfer / Payment: Debit to AMEX EPAYMENT - Cozlow",
  "2026-09-11",
  "checking",
  "-2136",
);
const credit = draft("e2", "AUTOPAY PAYMENT - THANK YOU", "2026-09-10", "card", "2136");
type Row = { id: string; memo: string };
/** Synthetic evidence for the preview only: the page answers the evidence read itself. */
const EVIDENCE = {
  history: {
    reference: "738700a6-2b1c-4c5d-9e8f-0a1b2c3d4e5f",
    entries: [
      {
        id: "e2",
        entry_date: "2026-09-11",
        created_at: "2026-09-11T10:47:00Z",
        memo: "Online Transfer / Payment: Credit from PREMIER ESTATE P - Valiance Media LLC",
        reason: "",
        status: "posted",
        action: "Original",
        actor: "System",
        payroll_run_id: null,
      },
    ],
  },
  rules: [],
  sources: [
    {
      id: "s1",
      source_system: "simplefin",
      external_id: "TRN-109806ff-6a3c-409b-b88a-70f72d56d097",
      observed_at: "2026-09-11T10:47:00Z",
      raw_payload: {
        id: "TRN-109806ff-6a3c-409b-b88a-70f72d56d097",
        mcc: null,
        memo: "",
        payee: "Online Transfer",
        amount: "3000.00",
        posted: 1789128000,
        description: "Online Transfer / Payment: Credit from PREMIER ESTATE P - Valiance Media LLC",
        transacted_at: 1789128000,
      },
    },
  ],
  notes: [
    { id: "n1", note: "Retainer for September, invoice 1042.", created_at: "2026-09-12T22:40:00Z" },
  ],
  documents: [
    { id: "d1", original_name: "premier-estate-remittance.pdf", size_bytes: "48211", mime_type: "application/pdf" },
  ],
  audit: [
    { id: "a1", table_name: "journal_entries", action: "entry.review", recorded_at: "2026-09-12T22:35:00Z", before_value: null, after_value: null },
    { id: "a2", table_name: "journal_entries", action: "transaction.save", recorded_at: "2026-09-12T22:35:00Z", before_value: null, after_value: null },
    { id: "a3", table_name: "journal_entries", action: "sync", recorded_at: "2026-09-11T10:47:00Z", before_value: null, after_value: null },
  ],
};

export default function Page() {
  const [out, setOut] = useState("uncat_out");
  const [inn, setInn] = useState("sales");
  const [rowClicks, setRowClicks] = useState(0);
  const [event, setEvent] = useState("nothing yet");
  const [dialog, setDialog] = useState(false);
  const [journal, setJournal] = useState<Editor | null>(null);
  const [simple, setSimple] = useState<"new" | "correct" | null>(null);
  const manage = { profiles, parties: [], periods: [], preferences: null };
  useEffect(() => {
    const real = window.fetch;
    window.fetch = (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("view=evidence"))
        return Promise.resolve(
          new Response(JSON.stringify(EVIDENCE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      return real(input, init);
    };
    return () => {
      window.fetch = real;
    };
  }, []);
  const outMenu = categoryMenu(categoryGroups(accounts, profiles, "out"), accounts, {
    current: out,
    prior: { last_category: "software", payee_id: null, count: 3 },
  });
  const inMenu = categoryMenu(categoryGroups(accounts, profiles, "in"), accounts, {
    current: inn,
    payeeDefault: "saas",
  });
  return (
    <PrivacyProvider>
    <main className="mx-auto max-w-3xl space-y-8 p-10">
      <p className="text-sm text-muted-foreground" data-testid="state">
        Row clicks: {rowClicks} · Last picker event: {event}
      </p>
      <DataTable<Row>
        columns={[
          { key: "memo", header: "Description", render: (r) => r.memo },
          {
            key: "category",
            header: "Category",
            width: "w-56",
            render: () => (
              <AccountingCategoryPicker
                label="Category for Amazon"
                compact
                value={out}
                groups={outMenu}
                direction="out"
                placeholder="Uncategorized expense"
                transfer={{
                  account: "CIARAN D MCINTYRE -2005",
                  date: "2026-09-10",
                  onSelect: () => {
                    setEvent("transfer dialog opened");
                    setDialog(true);
                  },
                }}
                onChange={(id) => {
                  setOut(id);
                  setEvent(`chose ${id}`);
                }}
                className="w-full text-warning"
              />
            ),
          },
        ]}
        data={[{ id: "1", memo: "AMAZON MKTPLACE" }]}
        keyExtractor={(r) => r.id}
        onRowClick={() => setRowClicks((n) => n + 1)}
      />
      <div className="flex flex-wrap items-end gap-6">
        <div className="glass-card w-72 rounded-xl p-3">
          <AccountingCategoryPicker
            label="Category"
            visibleLabel="Category"
            value={inn}
            groups={inMenu}
            direction="in"
            placeholder="Choose a category"
            onChange={setInn}
          />
        </div>
        <Button variant="outline" onClick={() => setDialog(true)}>
          Open transfer dialog
        </Button>
        <Button variant="outline" onClick={() => setJournal(makeEditor("2026-09-13"))}>
          Open journal editor
        </Button>
        <Button variant="outline" onClick={() => setSimple("new")}>
          Open deposit editor
        </Button>
        <Button variant="outline" onClick={() => setSimple("correct")}>
          Open correction
        </Button>
      </div>
      {simple && (
        <AccountingTransactionEditor
          entry={simple === "correct" ? { ...credit, status: "posted", memo: "Online Transfer / Payment: Credit from PREMIER ESTATE P - Valiance Media LLC" } : undefined}
          initialDirection="in"
          date="2026-09-13"
          accounts={accounts}
          manage={manage}
          onClose={() => setSimple(null)}
          onSaved={async () => setSimple(null)}
          onJournal={() => setSimple(null)}
        />
      )}
      <JournalEditorDialog
        editor={journal}
        setEditor={setJournal}
        accounts={accounts}
        manage={manage}
        busy={false}
        error=""
        onSave={() => setEvent("journal saved")}
        onClose={() => setJournal(null)}
      />
      {dialog && (
        <AccountingTransferFromDraft
          entry={debit}
          counterpart={credit}
          accounts={accounts}
          profiles={profiles}
          revision="preview"
          onClose={() => setDialog(false)}
          onSaved={async () => setDialog(false)}
        />
      )}
    </main>
    </PrivacyProvider>
  );
}
