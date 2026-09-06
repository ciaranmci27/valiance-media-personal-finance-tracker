import assert from "node:assert/strict";
import {
  readCsv,
  journalGroups,
  bankGroups,
  csvAmount,
  csvDate,
  safeCsvCell,
  type CsvOptions,
} from "../src/lib/accounting/imports/csv";
import { fixtureAccountId } from "../src/lib/accounting/fixtures";
const options: CsvOptions = {
  delimiter: ",",
  headerRow: 0,
  dateFormat: "yyyy-mm-dd",
  decimal: ".",
  thousands: ",",
};
let checks = 0;
const check = (a: unknown, b: unknown) => {
  assert.deepEqual(a, b);
  checks++;
};
const text =
  "Group,Date,Memo,Account,Debit,Credit\na,2025-12-01,Opening,Bank,1000,\na,2025-12-01,Opening,Equity,,1000\nb,2026-01-01,Purchase,Cost,50,\nb,2026-01-01,Purchase,Bank,,50\nc,2026-01-01,Purchase,Cost,50,\nc,2026-01-01,Purchase,Bank,,50";
const mapping = {
  group: "Group",
  date: "Date",
  memo: "Memo",
  account: "Account",
  debit: "Debit",
  credit: "Credit",
  stableGroupIds: false,
  accounts: {
    Bank: fixtureAccountId(1),
    Equity: fixtureAccountId(4),
    Cost: fixtureAccountId(6),
  },
};
const groups = journalGroups(readCsv(text, options), options, mapping);
check(groups.length, 3);
check(
  groups.every((g) => g.errors.length === 0),
  true,
);
check(groups[1].fingerprint, groups[2].fingerprint);
check(groups[1].external_id === groups[2].external_id, false);
const rows = text.split("\n");
const reordered = [rows[0], ...rows.slice(1).reverse()].join("\n");
check(
  journalGroups(readCsv(reordered, options), options, mapping)
    .map((g) => g.external_id)
    .sort(),
  groups.map((g) => g.external_id).sort(),
);
check(csvAmount("1,234.50", options), BigInt(123450));
check(csvAmount("(12.50)", options), BigInt(-1250));
check(csvAmount("1.234,50", { decimal: ",", thousands: "." }), BigInt(123450));
for (const amount of ["12,34.50", "1.234", "1e3", "$50", "--10"]) {
  assert.throws(() => csvAmount(amount, options));
  checks++;
}
check(csvDate("31/12/2025", "dd/mm/yyyy"), "2025-12-31");
assert.throws(() => csvDate("02/29/2025", "mm/dd/yyyy"));
checks++;
assert.throws(() => readCsv("a,a\n1,2", options));
checks++;
assert.throws(() =>
  journalGroups(readCsv(text, options), options, { ...mapping, group: "" }),
);
checks++;
const bad = journalGroups(
  readCsv(text.replace("Equity,,1000", "Equity,,999"), options),
  options,
  mapping,
);
check(
  bad[0].errors.some((e) => e.includes("balance")),
  true,
);
const bank = bankGroups(
  readCsv(
    "Date,Description,Amount\n2026-01-01,Card purchase,-12.50\n2026-01-02,Card payment,12.50",
    options,
  ),
  options,
  {
    date: "Date",
    description: "Description",
    amount: "Amount",
    sign: "deposits_positive",
    accountId: fixtureAccountId(3),
  },
);
check(
  bank.map((g) => g.bank_amount_cents),
  ["-1250", "1250"],
);
check(
  bank.every((g) => !g.errors.length),
  true,
);
check(safeCsvCell("=CMD()"), "'=CMD()");
console.log(`Accounting import parsing: ${checks} assertions passed.`);
