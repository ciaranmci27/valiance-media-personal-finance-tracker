import { notFound } from "next/navigation";
import { z } from "zod";
import { ACCOUNTING_ENABLED, isLocalOrTestEnv } from "@/lib/env";
import { isDemoMode } from "@/lib/demo";
import { getAccountingDemo } from "@/lib/accounting/demo";
import {
  accountingClient,
  accountingError,
} from "@/lib/accounting/server/access";
import {
  dateSchema,
  type AccountingWorkspace,
} from "@/lib/accounting/contracts";
import { AccountingBooks } from "@/components/features/accounting/accounting-books";
import { PageHeader } from "@/components/layout/page-header";
import { AccountingSetup } from "@/components/features/accounting/accounting-setup";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Accounting" };
export const dynamic = "force-dynamic";

export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!ACCOUNTING_ENABLED) notFound();
  const testing =
    isLocalOrTestEnv && Boolean(process.env.ACCOUNTING_TEST_DATABASE_URL);
  if (isDemoMode() && !testing)
    return <AccountingBooks initial={getAccountingDemo()} demo />;
  const params = await searchParams;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Phoenix",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const from = dateSchema.safeParse(
    params.from ?? `${today.slice(0, 4)}-01-01`,
  );
  const to = dateSchema.safeParse(params.to ?? today);
  const entry = params.entry ? z.uuid().safeParse(params.entry) : null;
  let data: AccountingWorkspace | null = null;
  let problem = "";
  let setupOwnerId: string | null = null;
  if (
    !from.success ||
    !to.success ||
    from.data > to.data ||
    (entry && !entry.success)
  )
    problem = "Choose a valid report date range or entry link.";
  else {
    try {
      const client = await accountingClient();
      const result = await client.rpc("acct_workspace", {
        p_from: from.data,
        p_to: to.data,
        p_entry_id: entry?.success ? entry.data : null,
      });
      if (result.error) problem = accountingError(result.error.message);
      else data = result.data as AccountingWorkspace;
    } catch {
      problem =
        "Accounting is not configured for this signed-in owner. Complete the accounting setup before opening the books.";
      if (!testing) {
        const client = await createClient();
        const {
          data: { user },
        } = await client.auth.getUser();
        setupOwnerId = user?.id ?? null;
      }
    }
  }
  if (!data)
    return (
      <div className="space-y-6">
        <PageHeader title="Accounting" subtitle="Company books" />
        <div className="glass-card p-6">
          <p role="alert">{problem}</p>
          <p className="mt-3 text-sm text-muted-foreground">
            Your existing personal finance pages remain available.
          </p>
          {setupOwnerId && <AccountingSetup ownerId={setupOwnerId} />}
        </div>
      </div>
    );
  return (
    <AccountingBooks
      key={`${data.from}-${data.to}-${entry?.success ? entry.data : "all"}`}
      initial={data}
      testing={testing}
      detailOnly={entry?.success === true}
    />
  );
}
