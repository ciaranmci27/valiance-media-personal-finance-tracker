"use client";
import { useState } from "react";
import { Copy, Check, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
export function AccountingSetup({ ownerId }: { ownerId: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  const sql = `INSERT INTO public.acct_settings (owner_user_id, legal_name)\nVALUES ('${ownerId}'::uuid, 'Valiance Media LLC');`;
  return (
    <div className="mt-6 space-y-4 border-t border-border pt-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="text-primary" size={18} />
        <h2 className="font-semibold">Finish owner setup</h2>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Apply the accounting migrations in Supabase, then run this SQL for your
        signed-in account. This grants access to one owner. If an owner is
        already configured, the insert will fail without replacing them.
      </p>
      <pre className="overflow-x-auto rounded-lg border border-border bg-secondary/30 p-4 text-xs">
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
          {copied ? <Check size={15} /> : <Copy size={15} />}Copy owner setup
          SQL
        </Button>
        <Button onClick={() => window.location.reload()}>
          Check setup again
        </Button>
      </div>
      {error && <p className="text-sm text-muted-foreground">{error}</p>}
      <p className="text-xs text-muted-foreground">
        After setup, start with Accounts to choose your chart, then Manage →
        Imports to preview your history.
      </p>
    </div>
  );
}
