"use client";
import { useState } from "react";
import { ArrowRight, Copy, Check, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
export function AccountingSetup({ ownerId }: { ownerId: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  const sql = `INSERT INTO accounting.settings (owner_user_id)\nVALUES ('${ownerId}'::uuid);`;
  return (
    <div className="mt-6 space-y-4 border-t border-border pt-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="text-teal-light" size={18} aria-hidden="true" />
        <h2 className="font-semibold">Finish owner setup</h2>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Two one-time steps in the Supabase dashboard. Under Project Settings,
        API, add <code className="font-mono text-xs">accounting</code> to the
        exposed schemas. Then run this SQL for your signed-in account. It names
        one owner; if an owner is already configured the insert fails without
        replacing them.
      </p>
      <pre className="overflow-x-auto glass-card rounded-xl bg-secondary/30 p-4 text-xs">
        {sql}
      </pre>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(sql);
              setCopied(true);
            } catch {
              setError("Select and copy the SQL above.");
            }
          }}
        >
          {copied ? (
            <Check size={15} aria-hidden="true" />
          ) : (
            <Copy size={15} aria-hidden="true" />
          )}
          Copy owner setup SQL
        </Button>
        <Button onClick={() => window.location.reload()}>
          Check setup again
        </Button>
      </div>
      {error && <p className="text-sm text-muted-foreground">{error}</p>}
      <p className="text-xs text-muted-foreground">
        After setup, review the seeded chart under Accounts, fill in Business
        settings, then More{" "}
        <ArrowRight
          size={12}
          className="inline align-middle"
          aria-hidden="true"
        />{" "}
        Imports to bring in your Wave history.
      </p>
    </div>
  );
}
