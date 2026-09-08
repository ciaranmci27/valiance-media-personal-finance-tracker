import { NextRequest, NextResponse } from "next/server";
import {
  taxWorkerAuthorized,
  taxServer,
} from "@/lib/accounting/server/tax-service";
import { refreshTaxLink } from "@/lib/accounting/tax-refresh";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;
export async function POST(req: NextRequest) {
  if (!taxWorkerAuthorized(req.headers.get("authorization")))
    return NextResponse.json(
      { error: "Unauthorized or tax worker disabled." },
      { status: 401 },
    );
  try {
    const due = (await taxServer({ type: "due" })) as { id: string }[];
    const outcomes = [];
    for (const link of due.slice(0, 5))
      outcomes.push(await refreshTaxLink(taxServer, link.id, true));
    return NextResponse.json(
      { processed: outcomes.length, outcomes },
      {
        status: outcomes.some((r) => r.state === "failed") ? 503 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return NextResponse.json(
      {
        error:
          "The tax worker could not complete its refresh. The durable job will be retried.",
      },
      { status: 503 },
    );
  }
}
