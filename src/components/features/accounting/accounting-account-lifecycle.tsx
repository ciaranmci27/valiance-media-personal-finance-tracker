"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { CloseHistory } from "@/lib/accounting/close";
import { AccountingDocumentPicker } from "./accounting-document-picker";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";

export function AccountLifecycle({
  account,
  onClose,
  onSaved,
}: {
  account: AccountingAccount;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [history, setHistory] = useState<CloseHistory | null>(null),
    [opened, setOpened] = useState(""),
    [closed, setClosed] = useState(""),
    [doc, setDoc] = useState(""),
    [reason, setReason] = useState("");
  const cmd = useAccountingCommand(onSaved);
  useEffect(() => {
    const abort = new AbortController();
    accountingGet<CloseHistory>({ view: "close-history" }, abort.signal)
      .then((h) => {
        setHistory(h);
        const r = h.lifecycle.find((l) => l.account_id === account.id);
        setOpened(r?.opened_on ?? "");
        setClosed(r?.closed_on ?? "");
        setDoc(r?.closure_document_id ?? "");
      })
      .catch((e) => {
        if (!abort.signal.aborted) cmd.setError(e.message);
      });
    return () => abort.abort();
  }, [account.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Account dates · {account.name}</DialogTitle>
          <DialogDescription>
            A closed bank or card account stops requiring later statements. Its
            books and final statement must both show zero, and every recorded
            transaction must fit these dates.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!history) return;
            await cmd.execute({
              type: "account.lifecycle",
              id: account.id,
              expected_version:
                history.lifecycle.find((l) => l.account_id === account.id)
                  ?.version ?? 0,
              expected_revision: history.revision,
              opened_on: opened,
              closed_on: closed || null,
              document_id: closed ? doc || null : null,
              reason,
            });
          }}
        >
          <Input
            label="Account opened on"
            type="date"
            required
            value={opened}
            onChange={(e) => setOpened(e.target.value)}
          />
          <Input
            label="Account closed on (leave blank if active)"
            type="date"
            min={opened}
            value={closed}
            onChange={(e) => setClosed(e.target.value)}
          />
          {closed && (
            <AccountingDocumentPicker
              value={doc}
              onChange={setDoc}
              label="Final statement or closure confirmation"
            />
          )}
          <Input
            label="Reason for this account-date review"
            maxLength={1000}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {cmd.error && (
            <p role="alert" className="text-sm text-error">
              {cmd.error}
            </p>
          )}
          <Button
            type="submit"
            disabled={!history || cmd.busy}
            loading={cmd.busy}
          >
            Save account dates
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
