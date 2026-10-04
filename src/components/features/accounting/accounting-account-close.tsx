"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/inputs/DateInput";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { AccountProfile } from "@/lib/accounting/workflows";
import { useAccountingCommand } from "./use-accounting-command";
import { dateLabel, todayInBooks } from "./format";

/** What the owner is doing to an account: closing it, or reopening a closed one. */
export type AccountCloseIntent = {
  mode: "close" | "reopen";
  account: AccountingAccount;
};

/** The chart tag for a closed account, as "Closed Mar 4, 2024". */
export function closedTag(closedOn: string) {
  return `Closed ${dateLabel(closedOn)}`;
}

/**
 * Close or reopen a bank, card or cash account. Closing asks for one date,
 * defaulting to the account's last activity; the books refuse with the
 * reason (a balance left, or something dated later) when it cannot close.
 */
export function AccountingAccountClose({
  intent,
  profile,
  demo,
  onRefresh,
  onDone,
}: {
  intent: AccountCloseIntent;
  profile: AccountProfile | undefined;
  demo: boolean;
  onRefresh: () => Promise<void>;
  onDone: () => void;
}) {
  const { mode, account } = intent;
  const today = todayInBooks();
  const lastActivity = profile?.last_activity_on ?? null;
  const [closedOn, setClosedOn] = useState(lastActivity ?? today);
  const command = useAccountingCommand(onRefresh);
  const closing = mode === "close";
  async function submit() {
    const result = await command.execute(
      closing
        ? {
            type: "account.close",
            id: account.id,
            expected_version: profile?.version ?? 0,
            closed_on: closedOn,
          }
        : {
            type: "account.reopen",
            id: account.id,
            expected_version: profile?.version ?? 0,
          },
    );
    if (!result) return;
    toast(
      "success",
      closing ? `${account.name} is closed.` : `${account.name} is open again.`,
    );
    onDone();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.busy) onDone();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="break-words">
            {closing ? "Close" : "Reopen"} {account.name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {closing
              ? "Closed accounts keep their history in every report. Nothing new can be dated after the closing date, and the bank feed stops."
              : "The account takes new transactions again and its bank feed resumes."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {closing && (
            <DateInput
              label="Closing date"
              value={closedOn}
              onChange={setClosedOn}
              maxDate={today}
              required
              description={
                lastActivity
                  ? `Last activity ${dateLabel(lastActivity)}.`
                  : "No activity yet."
              }
            />
          )}
          {command.error && (
            <p role="alert" className="text-sm text-error">
              {command.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={command.busy}
              onClick={onDone}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={command.busy}
              disabled={demo || (closing && !closedOn)}
            >
              {closing ? "Close account" : "Reopen account"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
