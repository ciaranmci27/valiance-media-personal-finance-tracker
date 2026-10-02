import { withBootArrival } from "@/components/layout/boot-arrival";
import { loadAccountingWorkspace } from "@/lib/accounting/server/workspace";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ACCOUNTING_ENABLED, isLocalOrTestEnv } from "@/lib/env";
import { isDemoMode } from "@/lib/demo";
import { getAccountingDemo } from "@/lib/accounting/demo";
import { accountingError } from "@/lib/accounting/server/access";
import {
  dateSchema,
  type AccountingWorkspace,
} from "@/lib/accounting/contracts";
import { AccountingBooks } from "@/components/features/accounting/accounting-shell";
import { PageHeader } from "@/components/layout/page-header";
import { AccountingSetup } from "@/components/features/accounting/accounting-setup";
import { createClient } from "@/lib/supabase/server";
import { AccessDenied } from "@/components/features/access-denied";
import { resolveAccess } from "@/lib/team/access";
import { hasPermission } from "@/lib/access-control";
import {
  bootQueries,
  preloadContextFromLocation,
  viewQueries,
  type PreloadContext,
} from "@/lib/accounting/preload";
import { resolveAccountingView } from "@/lib/accounting/views";
import { preloadAccountingReads } from "@/lib/accounting/server/preload-reads";
import type { PreloadedReads } from "@/lib/accounting/read-cache";

export const metadata = { title: "Accounting" };
export const dynamic = "force-dynamic";

async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!ACCOUNTING_ENABLED) notFound();
  const resolved = await resolveAccess();
  if (resolved.state !== "ok" || !hasPermission(resolved.access, "accounting.manage"))
    return <AccessDenied area="Accounting" />;
  const isTeamOwner = resolved.access.member.role === "owner";
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
  let preloaded: PreloadedReads | undefined;
  if (
    !from.success ||
    !to.success ||
    from.data > to.data ||
    (entry && !entry.success)
  )
    problem = "Choose a valid report date range or entry link.";
  else {
    // What the shell's first screen will ask for, read alongside the
    // workspace instead of after the page hydrates. Its context is built the
    // way the shell builds it; a key that comes out different is just read
    // again by the screen. Entry links open a single transaction and skip it.
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (first !== undefined) search.set(key, first);
    }
    const view = resolveAccountingView(search.get("view"), search.get("section"));
    const preloadContext = (reviewCount: number): PreloadContext => ({
      ...preloadContextFromLocation(search, today, reviewCount),
      from: from.data,
      to: to.data,
      entry: null,
    });
    // Only the ledger's first page depends on the review count, which the
    // workspace answers; every other screen's reads can start right away.
    const early = entry
      ? null
      : preloadAccountingReads([
          ...bootQueries(preloadContext(0)),
          ...(view === "journal" ? [] : viewQueries(view, preloadContext(0))),
        ]);
    try {
      const result = await loadAccountingWorkspace({
        from: from.data,
        to: to.data,
        entry_id: entry?.success ? entry.data : null,
      });
      if (result.error) problem = accountingError(result.error.message);
      else data = result.data as AccountingWorkspace;
      if (data && early) {
        const reviewCount = data.needs_review_count ?? data.draft_count;
        const [first, ledger] = await Promise.all([
          early,
          view === "journal"
            ? preloadAccountingReads(
                viewQueries(view, preloadContext(reviewCount)),
              )
            : null,
        ]);
        preloaded = ledger
          ? { at: first.at, reads: [...first.reads, ...ledger.reads] }
          : first;
      }
    } catch {
      problem = isTeamOwner
        ? "The books are not set up yet. Finish the setup below before opening them."
        : "The books are not set up yet. Ask the owner to finish the accounting setup.";
      if (!testing && isTeamOwner) {
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
      preloaded={preloaded}
      testing={testing}
      detailOnly={entry?.success === true}
    />
  );
}

export default withBootArrival(AccountingPage);
