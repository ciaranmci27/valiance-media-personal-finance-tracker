// Invoices paid before the sync went live never reach the ledger, whatever the
// event; later ones still do. Run: npm run test:invoice-income
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  INVOICE_SYNC_STARTED,
  reconcileInvoiceIncome,
  type InvoiceEvent,
} from "../src/lib/webhooks/reconcile-invoice-income";

let calls = 0;
const touchesDb = new Proxy({}, {
  get() {
    calls++;
    throw new Error("reached the database");
  },
}) as unknown as SupabaseClient;

function event(type: string, paidDate: string | null): InvoiceEvent {
  return {
    id: "evt_test",
    type,
    sequence: 99,
    created_at: "2026-09-20T08:07:00Z",
    data: {
      invoice: { id: "inv", invoice_number: "INV-001", paid: type !== "invoice.deleted", paid_date: paidDate },
      totals_by_type: { hourly: 2750.28, recurring: 2500 },
    },
  };
}

async function main() {
  for (const type of ["invoice.paid", "invoice.updated", "invoice.deleted"]) {
    calls = 0;
    const result = await reconcileInvoiceIncome(touchesDb, event(type, "2026-04-27"));
    assert.equal(result.status, "before_sync", `${type} for an April invoice is skipped`);
    assert.equal(calls, 0, `${type} for an April invoice touches nothing`);
  }

  await assert.rejects(
    reconcileInvoiceIncome(touchesDb, event("invoice.updated", INVOICE_SYNC_STARTED)),
    /reached the database/,
    "an invoice paid on the start day is synced",
  );
  await assert.rejects(
    reconcileInvoiceIncome(touchesDb, event("invoice.updated", null)),
    /reached the database/,
    "an unpaid invoice falls back to the event date and is synced",
  );

  console.log("invoice income cutoff: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
