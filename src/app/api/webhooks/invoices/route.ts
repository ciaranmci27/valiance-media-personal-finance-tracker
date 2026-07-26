import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase/service";
import { verifyWebhookSignature } from "@/lib/webhooks/verify";
import { reconcileInvoiceIncome, type InvoiceEvent } from "@/lib/webhooks/reconcile-invoice-income";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KNOWN_TYPES = new Set(["invoice.paid", "invoice.updated", "invoice.deleted"]);

// Receives signed invoice events from the CRM and reconciles them into the
// income ledger. Returns 2xx to acknowledge; any 4xx/5xx makes the sender
// retry (so transient failures self-heal).
export async function POST(req: NextRequest) {
  const secret = process.env.INVOICE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("INVOICE_WEBHOOK_SECRET is not set; cannot verify invoice webhooks");
    return NextResponse.json({ error: "Receiver not configured" }, { status: 500 });
  }

  // Verify over the RAW body before parsing.
  const raw = await req.text();
  if (!verifyWebhookSignature(secret, req.headers.get("x-vm-signature"), raw)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: InvoiceEvent;
  try {
    event = JSON.parse(raw) as InvoiceEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Acknowledge (200) event types we don't handle so the sender stops retrying.
  if (!event?.type || !KNOWN_TYPES.has(event.type)) {
    return NextResponse.json({ received: true, ignored: true }, { status: 200 });
  }
  if (!event.data?.invoice?.id) {
    return NextResponse.json({ error: "Missing invoice id" }, { status: 400 });
  }

  try {
    const result = await reconcileInvoiceIncome(getServiceClient(), event);
    return NextResponse.json({ received: true, ...result }, { status: 200 });
  } catch (e) {
    console.error("Invoice webhook reconcile failed", e);
    return NextResponse.json({ error: "Reconcile failed" }, { status: 500 });
  }
}
