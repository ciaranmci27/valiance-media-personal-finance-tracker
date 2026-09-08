"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Download,
  FileArchive,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { SectionHeader } from "@/components/ui/section-header";
import {
  booksPackageScopeSchema,
  type BooksPackagePreview,
  type BooksPackageHistory,
} from "@/lib/accounting/books-package";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { countLabel, dateLabel, timestampLabel, todayInBooks } from "./format";

const sections = [
  [
    "Financial statements",
    "Profit & loss, balance sheet, bank cash movements and trial balance.",
  ],
  [
    "Transaction detail",
    "Complete general ledger and owner activity, with exact amounts.",
  ],
  [
    "Payroll and year-end schedules",
    "Payroll registers and payables, officer reconciliation, contractors, assets and loans.",
  ],
  [
    "Tax and source support",
    "Account mappings, reviewed tax adjustments, basis support and a source-document index.",
  ],
];
const PAGE_SIZE = 25;
export function AccountingBooksPackage({
  to,
  revision,
  onBack,
}: {
  to: string;
  revision: string;
  onBack: () => void;
}) {
  const params = useSearchParams(),
    fallback = to > todayInBooks() ? todayInBooks() : to;
  const candidate = booksPackageScopeSchema.safeParse({
    year: Number(params.get("package_year") ?? fallback.slice(0, 4)),
    through: params.get("package_through") ?? fallback,
  });
  const applied = candidate.success
    ? candidate.data
    : { year: Number(fallback.slice(0, 4)), through: fallback };
  const signature = JSON.stringify(applied);
  const [year, setYear] = useState(String(applied.year)),
    [through, setThrough] = useState(applied.through),
    [preview, setPreview] = useState<BooksPackagePreview | null>(null),
    [history, setHistory] = useState<BooksPackageHistory>({
      rows: [],
      count: 0,
    }),
    [offset, setOffset] = useState(0),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [downloading, setDownloading] = useState<string | null>(null);
  const request = useAccountingCommand(),
    capture = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => {
    const scope = JSON.parse(signature);
    setYear(String(scope.year));
    setThrough(scope.through);
    setOffset(0);
  }, [signature]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const scope = JSON.parse(signature);
    Promise.all([
      accountingGet<BooksPackagePreview>(
        {
          view: "books-package",
          year: String(scope.year),
          through: scope.through,
        },
        controller.signal,
      ),
      accountingGet<BooksPackageHistory>(
        {
          view: "books-package-history",
          year: String(scope.year),
          offset: String(offset),
        },
        controller.signal,
      ),
    ])
      .then(([data, history]) => {
        setPreview(data);
        setHistory(history);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e.message ?? "Unable to load the books package.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [signature, revision, offset, refresh]);
  function apply() {
    const scope = booksPackageScopeSchema.safeParse({
      year: Number(year),
      through,
    });
    if (!scope.success || through > todayInBooks()) {
      setError("Choose a cutoff within the selected year, through today.");
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("package_year", String(scope.data.year));
    url.searchParams.set("package_through", scope.data.through);
    window.history.pushState(null, "", url);
    setRefresh((n) => n + 1);
  }
  async function retain() {
    if (!preview || loading) return;
    const key = JSON.stringify({
      year: preview.year,
      through: preview.through,
      revision: preview.revision,
    });
    if (capture.current?.signature !== key)
      capture.current = { signature: key, id: crypto.randomUUID() };
    const result = await request.execute({
      type: "report.books.capture",
      id: capture.current.id,
      expected_revision: preview.revision,
      year: preview.year,
      through: preview.through,
    });
    if (result) {
      capture.current = null;
      setOffset(0);
      setRefresh((n) => n + 1);
    }
  }
  async function download(id: string, format: "zip" | "csv-zip" | "json") {
    if (downloading) return;
    setDownloading(id);
    setError("");
    try {
      const response = await fetch(
        `/api/accounting/packages/${id}?format=${format}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        const result = await response.json();
        throw new Error(
          result.error ?? "Unable to download this retained package.",
        );
      }
      const url = URL.createObjectURL(await response.blob()),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        response.headers
          .get("content-disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ??
        `books-package-${id.slice(0, 8)}.${format === "json" ? "json" : "zip"}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The download was interrupted. Retry the retained package.",
      );
    } finally {
      setDownloading(null);
    }
  }
  const blocked =
    !preview ||
    loading ||
    String(preview.year) !== year ||
    preview.through !== through ||
    preview.incomplete_imports > 0 ||
    preview.ledger_count > 100000;
  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-6">
      <div>
        <Button
          variant="link"
          size="sm"
          onClick={onBack}
          className="mb-3 h-auto px-0 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" />
          All reports
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">
              Year-end books package
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Keep a complete review set together. Every statement and worksheet
              is retained at the same book revision.
            </p>
          </div>
          <Button
            disabled={blocked || request.busy}
            onClick={() => void retain()}
          >
            <FileArchive aria-hidden="true" />
            {request.busy ? "Retaining package..." : "Create package"}
          </Button>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
        className="glass-card flex flex-wrap items-end gap-3 rounded-xl p-4"
      >
        <Input
          id="package-year"
          label="Year"
          type="number"
          min="1900"
          max="2100"
          value={year}
          className="w-28"
          onChange={(event) => {
            const value = event.target.value;
            setYear(value);
            if (
              /^\d{4}$/.test(value) &&
              Number(value) >= 1900 &&
              Number(value) <= 2100
            )
              setThrough(
                `${value}-12-31` < todayInBooks()
                  ? `${value}-12-31`
                  : todayInBooks(),
              );
          }}
        />
        <Input
          id="package-through"
          label="Through"
          type="date"
          value={through}
          max={todayInBooks()}
          onChange={(event) => setThrough(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={loading || request.busy}
        >
          Update scope
        </Button>
        <span className="ml-auto pb-2 text-xs text-muted-foreground">
          Posted books · January 1 through cutoff
        </span>
      </form>
      {(error || request.error) && (
        <p
          role="alert"
          className="rounded-lg border border-error/30 p-4 text-sm text-error"
        >
          {error || request.error}
        </p>
      )}
      {preview && (
        <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
          <section className="glass-card overflow-hidden rounded-xl">
            <div className="border-b border-border p-5">
              <SectionHeader
                className="mb-0"
                label="Included in your package"
                action={
                  <span className="text-xs text-muted-foreground">
                    Revision {preview.revision}
                  </span>
                }
              />
            </div>
            <div className="divide-y divide-border">
              {sections.map(([title, description]) => (
                <div className="flex gap-3 p-5" key={title}>
                  <Check
                    size={16}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-teal-light"
                  />
                  <div>
                    <p className="text-sm font-medium">{title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <p className="border-t border-border px-5 py-4 text-xs leading-relaxed text-muted-foreground">
              PDFs for printable schedules, complete CSV detail, retained JSON
              and file hashes.{" "}
              {preview.ledger_count > 100000
                ? "Over 100,000"
                : preview.ledger_count.toLocaleString()}{" "}
              journal lines in scope. Actual source files stay in the document
              library.
            </p>
          </section>
          <section className="glass-card rounded-xl p-5">
            <SectionHeader
              label="Review before sharing"
              description="The package preserves these open items so a reviewer can see the limits of the available data."
            />
            {preview.incomplete_imports > 0 && (
              <p className="mt-4 text-sm text-warning">
                Complete {preview.incomplete_imports} imports before retaining
                this scope.
              </p>
            )}
            {preview.ledger_count > 100000 && (
              <p className="mt-4 text-sm text-warning">
                This scope exceeds the 100,000-line package limit. Use
                individual shorter-period reports.
              </p>
            )}
            <ul className="mt-4 space-y-3 text-sm">
              {preview.review_items.map((item) => (
                <li
                  key={item.kind}
                  className="flex gap-2 text-muted-foreground"
                >
                  <span className="text-warning" aria-hidden="true">
                    ·
                  </span>
                  {item.message}
                </li>
              ))}
            </ul>
            {preview.review_items.length === 0 && (
              <p className="mt-4 text-sm text-teal-light">
                No open package review items.
              </p>
            )}
            <p className="mt-5 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
              This supports accounting and tax preparation. It is not a filed
              return or a substitute for reviewing tax treatment.
            </p>
          </section>
        </div>
      )}
      <section className="glass-card overflow-hidden rounded-xl">
        <div className="border-b border-border p-5">
          <SectionHeader
            className="mb-0"
            label="Retained packages"
            count={history.count}
            action={
              <Button
                variant="ghost"
                size="sm"
                disabled={loading}
                onClick={() => setRefresh((n) => n + 1)}
              >
                <RefreshCw
                  aria-hidden="true"
                  className={loading ? "animate-spin" : ""}
                />
                Refresh
              </Button>
            }
          />
        </div>
        {!history.rows.length ? (
          <p className="p-6 text-sm text-muted-foreground">
            {loading
              ? "Loading packages..."
              : "Create the first package for this year. Later edits will not change a retained copy."}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {history.rows.map((row) => (
              <article
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-4 p-5"
              >
                <div>
                  <p className="text-sm font-medium">
                    January 1 through {dateLabel(row.to_date)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Revision {row.revision} · {timestampLabel(row.created_at)} ·{" "}
                    {countLabel(row.review_items.length, "review item")}
                  </p>
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      Capture details
                    </summary>
                    <p className="mt-2 break-all font-mono text-muted-foreground">
                      {row.id}
                    </p>
                    {row.review_items.map((item) => (
                      <p className="mt-2 text-muted-foreground" key={item.kind}>
                        {item.message}
                      </p>
                    ))}
                  </details>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!downloading}
                    onClick={() => void download(row.id, "zip")}
                  >
                    <Download aria-hidden="true" />
                    {downloading === row.id
                      ? "Preparing download..."
                      : "Download ZIP"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!downloading}
                    onClick={() => void download(row.id, "csv-zip")}
                  >
                    CSV only
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!downloading}
                    onClick={() => void download(row.id, "json")}
                  >
                    JSON
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
        <Pagination
          offset={offset}
          limit={PAGE_SIZE}
          total={history.count}
          onChange={setOffset}
          noun="packages"
          busy={loading}
          className="border-t border-border"
        />
      </section>
    </div>
  );
}
