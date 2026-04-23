"use client";

import * as React from "react";
import Link from "next/link";
import { Check, ChevronRight, Copy, KeyRound, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

function generateHexKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function PayrollEncryptionGuard() {
  const [generatedKey, setGeneratedKey] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const handleGenerate = () => {
    const key = generateHexKey();
    setGeneratedKey(key);
    setCopied(false);
  };

  const handleCopy = async () => {
    if (!generatedKey) return;
    const envLine = `AES_ENCRYPTION_KEY=${generatedKey}`;
    try {
      await navigator.clipboard.writeText(envLine);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("error", "Copy failed. Select the key manually.");
    }
  };

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-2xl items-center px-6">
      <div className="glass-card w-full rounded-2xl p-8">
        <div className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-teal/10 text-teal">
          <KeyRound className="h-6 w-6" aria-hidden="true" />
        </div>

        <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground font-semibold">
            1
          </span>
          <span className="font-medium text-foreground">Encryption key</span>
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="flex h-5 w-5 items-center justify-center rounded-full border border-border">
            2
          </span>
          <span>Organization</span>
        </div>

        <h1 className="mb-3 text-2xl font-semibold tracking-tight">
          Encryption key required
        </h1>

        <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
          Payroll stores encrypted SSN data. Set the{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            AES_ENCRYPTION_KEY
          </code>{" "}
          environment variable before using this feature.
        </p>

        <div className="mb-6 space-y-4 rounded-xl border border-border/60 bg-muted/30 p-4">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {generatedKey ? "Your generated key" : "Generate a secure key"}
              </p>
              {generatedKey ? (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleCopy}
                    className="h-7 px-2 text-xs"
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-teal" aria-hidden="true" />
                    ) : (
                      <Copy className="h-3 w-3" aria-hidden="true" />
                    )}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleGenerate}
                    className="h-7 px-2 text-xs"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    Regenerate
                  </Button>
                </div>
              ) : null}
            </div>

            {generatedKey ? (
              <div
                className="space-y-2"
                aria-live="polite"
                aria-atomic="true"
              >
                <button
                  type="button"
                  onClick={handleCopy}
                  aria-label={copied ? "Copied to clipboard" : "Click to copy env line"}
                  className="group relative block w-full cursor-pointer rounded-lg bg-background p-3 text-left font-mono text-xs leading-relaxed transition-colors hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <span className="block whitespace-pre-wrap break-all">
                    AES_ENCRYPTION_KEY={generatedKey}
                  </span>
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center rounded-b-lg bg-gradient-to-t from-background via-background/90 to-transparent py-1 text-[10px] uppercase tracking-wider text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                    {copied ? "Copied" : "Click to copy"}
                  </span>
                </button>
                <p className="text-xs text-muted-foreground">
                  Paste this line into your{" "}
                  <code className="font-mono">.env.local</code> file, then
                  restart the dev server.
                </p>
              </div>
            ) : (
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={handleGenerate}
                className="w-full"
              >
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                Generate Key
              </Button>
            )}
          </div>

          <details className="group">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded">
              Prefer the command line?
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-background p-3 font-mono text-xs">
              <code>node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;hex&apos;))&quot;</code>
            </pre>
          </details>
        </div>

        <p className="mb-5 text-xs leading-relaxed text-muted-foreground">
          Keep this key secure. Losing it means SSNs encrypted with it cannot
          be recovered. Rotating it invalidates all existing ciphertext.
        </p>

        <Link
          href="/"
          className="inline-flex items-center rounded text-sm font-medium text-teal underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
