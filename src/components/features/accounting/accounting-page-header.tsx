"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import type { AccountingView } from "@/lib/accounting/views";

/**
 * Where an accounting screen's page header lands. The shell renders the
 * slot at the top of the page, above the setup guide and notices, so each
 * screen can own its title and actions (and a detail screen can swap in its
 * own) while the header keeps the position every other page gives it.
 */
export interface AccountingHeaderSlot {
  node: HTMLElement | null;
  /** Shell-wide status (bank sync) shown beside the screen's actions. */
  status: ReactNode;
  /** Registers a mounted header; returns the release. */
  claim: () => () => void;
}

const HeaderSlotContext = createContext<AccountingHeaderSlot | null>(null);

export const AccountingHeaderProvider = HeaderSlotContext.Provider;

/** Each screen's title and description, as the sidebar names it. */
export function accountingHeader(
  view: AccountingView,
  legalName: string,
): { title: string; subtitle: string } {
  switch (view) {
    case "overview":
      return { title: "Overview", subtitle: `${legalName} books at a glance.` };
    case "journal":
      return {
        title: "Transactions",
        subtitle: "Review, categorize and search every transaction.",
      };
    case "accounts":
      return {
        title: "Accounts",
        subtitle: "Bank balances and the chart of accounts.",
      };
    case "payroll":
      return {
        title: "Payroll",
        subtitle:
          "Import payroll already processed in Patriot. Your report becomes a payroll record and a balanced journal entry.",
      };
    case "reports":
      return {
        title: "Reports",
        subtitle:
          "Statements first. Every number opens to the transactions behind it.",
      };
    case "manage":
      return {
        title: "Manage",
        subtitle:
          "Bank connections, receipts, registers, contacts, rules and year end.",
      };
    case "close":
      return {
        title: "Month end",
        subtitle:
          "Review what is left, confirm the balances, then lock the month. Locking posts nothing and creates no balancing entries.",
      };
  }
}

/**
 * The description line, hidden on phones the way Income and Expenses hide
 * theirs so the title row stays one line.
 */
export function HeaderSubtitle({ children }: { children: ReactNode }) {
  return <span className="hidden sm:inline">{children}</span>;
}

/**
 * The shared PageHeader for an accounting screen, rendered into the shell's
 * header slot. `back` adds the link a detail screen returns by. Outside the
 * shell it renders in place.
 */
export function AccountingPageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { label: string; onClick: () => void };
}) {
  const slot = useContext(HeaderSlotContext);
  const claim = slot?.claim;
  useLayoutEffect(() => claim?.(), [claim]);
  const header = (
    <>
      {back && (
        <Button
          variant="link"
          size="sm"
          onClick={back.onClick}
          className="mb-3 h-auto px-0 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" />
          {back.label}
        </Button>
      )}
      <PageHeader
        title={title}
        subtitle={subtitle && <HeaderSubtitle>{subtitle}</HeaderSubtitle>}
        actions={
          slot?.status || actions ? (
            <>
              {slot?.status}
              {actions}
            </>
          ) : undefined
        }
      />
    </>
  );
  if (!slot) return header;
  return slot.node ? createPortal(header, slot.node) : null;
}
