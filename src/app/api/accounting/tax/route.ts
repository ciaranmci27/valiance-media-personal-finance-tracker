import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  accountingClient,
  accountingError,
} from "@/lib/accounting/server/access";
import { readAccounting } from "@/lib/accounting/server/read";
import { buildBooksFigures } from "@/lib/accounting/tax-books-figures";
import type { TaxSource } from "@/lib/accounting/tax-workpapers";
import type { PayrollYear } from "@/lib/accounting/payroll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };
const query = z.object({
  year: z.coerce.number().int().min(1900).max(2100),
  through: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** Today in the books timezone, `YYYY-MM-DD`. */
function booksToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" }).format(
    new Date(),
  );
}

function previousDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * The figures the books can supply to the Tax Estimator for a year:
 * business profit and separately stated investment income from the ledger,
 * wages and withholding from the verified payroll register. No link row, no
 * snapshot, no worker: two reads flattened for the picker and the refresh.
 */
export async function GET(req: NextRequest) {
  let client: Awaited<ReturnType<typeof accountingClient>>;
  try {
    client = await accountingClient();
  } catch {
    return NextResponse.json(
      { error: "Accounting is unavailable for this session." },
      { status: 403 },
    );
  }

  const parsed = query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "Choose a tax year." }, { status: 400 });
  }
  const { year } = parsed.data;
  const today = booksToday();
  if (year > Number(today.slice(0, 4))) {
    return NextResponse.json(
      { error: "That tax year has not started." },
      { status: 400 },
    );
  }
  const yearEnd = `${year}-12-31`;
  const requested = parsed.data.through ?? today;
  let through = requested > yearEnd ? yearEnd : requested;
  if (through < `${year}-01-01`) {
    return NextResponse.json(
      { error: "Choose a cutoff inside the tax year." },
      { status: 400 },
    );
  }

  const readSource = (cutoff: string) =>
    readAccounting(client, "tax-source", { p_year: year, p_through: cutoff });
  const readPayroll = (cutoff: string) =>
    readAccounting(client, "payroll-year", { p_year: year, p_through: cutoff });

  let source = await readSource(through);
  // The books keep their own timezone; when the app's "today" is ahead of
  // theirs, the ledger read refuses the cutoff. Step back one day once.
  if (
    source.error &&
    /ACCT_TAX_RANGE/.test(source.error.message) &&
    parsed.data.through === undefined
  ) {
    through = previousDay(through);
    source = await readSource(through);
  }
  const payroll = await readPayroll(through);

  const result = buildBooksFigures({
    year,
    through,
    source: source.error ? null : (source.data as TaxSource),
    sourceError: source.error ? accountingError(source.error.message) : null,
    payroll: payroll.error ? null : (payroll.data as PayrollYear),
    payrollError: payroll.error ? accountingError(payroll.error.message) : null,
  });
  return NextResponse.json(result, { headers });
}
