/**
 * Human-friendly labels for payroll UX.
 *
 * Database status values are technical (draft, finalized, paid, scheduled,
 * generated) and end up meaning something different to an accountant than to
 * the small-business owner using this tool. This module maps them to plain
 * English the UI should surface everywhere users read state.
 *
 * Keep RUN_STATUS_LABELS et al. in types/payroll.ts for any place that needs
 * the literal state name (audit history, filter pills). Import from here
 * whenever a human reads the word.
 */

import type {
  DepositStatus,
  PayrollFormStatus,
  RunStatus,
} from "@/types/payroll";

export const RUN_STATUS_HUMAN: Record<RunStatus, string> = {
  draft: "Draft",
  finalized: "Approved",
  paid: "Paid out",
  voided: "Voided",
};

export const RUN_STATUS_HELP: Record<RunStatus, string> = {
  draft:
    "Numbers are editable. Approve to lock them in and schedule tax deposits.",
  finalized:
    "Numbers are locked. You still need to send wages through your bank, then come back and mark this run paid.",
  paid: "Wages have been sent and the pay stub is queued or delivered. Tax deposits for this run may still be due.",
  voided:
    "This run is excluded from YTD totals and tax filings. Kept for audit.",
};

export const DEPOSIT_STATUS_HUMAN: Record<DepositStatus, string> = {
  scheduled: "Scheduled",
  paid: "Paid",
  late: "Late",
};

export const DEPOSIT_STATUS_HELP: Record<DepositStatus, string> = {
  scheduled:
    "Awaiting payment. Pay before the due date to avoid IRS or state penalties.",
  paid: "Deposit has been sent. Keep the confirmation number on file.",
  late: "Past its due date. Pay as soon as possible; penalties accrue daily.",
};

export const FORM_STATUS_HUMAN: Record<PayrollFormStatus, string> = {
  draft: "Not started",
  generated: "Ready to review",
  filed: "Filed",
};

export const FORM_STATUS_HELP: Record<PayrollFormStatus, string> = {
  draft:
    "Form has not been generated yet. Open it, review the numbers, then click Generate.",
  generated:
    "Draft numbers are ready. Review, file it with the IRS or state, then mark it filed here.",
  filed: "Submitted and recorded. Confirmation number on file.",
};

// ─── Glossary ────────────────────────────────────────────────────────────────
/** Payroll terminology keyed by a short slug. Wrap any occurrence of the
 *  literal term in <Term slug="..."> to get a consistent tooltip. */

export type GlossarySlug =
  | "941"
  | "940"
  | "w2"
  | "w3"
  | "efw2"
  | "a1_qrt"
  | "a1_apr"
  | "a1_wp"
  | "a4"
  | "fica"
  | "futa"
  | "suta"
  | "sdi"
  | "ytd"
  | "gross"
  | "net"
  | "schedule_b"
  | "schedule_a"
  | "finalized"
  | "deposit"
  | "pay_run"
  | "pay_cycle"
  | "fit"
  | "sit"
  | "semiweekly"
  | "monthly_deposit"
  | "fein";

export interface GlossaryEntry {
  title: string;
  body: string;
}

export const GLOSSARY: Record<GlossarySlug, GlossaryEntry> = {
  "941": {
    title: "Form 941",
    body: "Employer's Quarterly Federal Tax Return. Reports federal income tax, Social Security, and Medicare withheld during the quarter plus the employer's matching share.",
  },
  "940": {
    title: "Form 940",
    body: "Employer's Annual Federal Unemployment (FUTA) Tax Return. Filed once a year and reports FUTA liability on the first $7,000 of each employee's wages.",
  },
  w2: {
    title: "Form W-2",
    body: "Wage and Tax Statement. Given to each employee in January reporting the prior year's wages and withholdings.",
  },
  w3: {
    title: "Form W-3",
    body: "Transmittal of Wage and Tax Statements. Summary sent to the SSA alongside the batch of W-2s.",
  },
  efw2: {
    title: "EFW2",
    body: "Electronic filing format used to submit W-2 data to the Social Security Administration in bulk.",
  },
  a1_qrt: {
    title: "Arizona A-1-QRT",
    body: "Arizona quarterly withholding reconciliation return. Reports state income tax withheld from Arizona wages each quarter.",
  },
  a1_apr: {
    title: "Arizona A-1-APR",
    body: "Arizona annual reconciliation of state withholding. Filed with the batch of W-2s at year end.",
  },
  a1_wp: {
    title: "Arizona A-1-WP",
    body: "Arizona withholding payment voucher. Used to remit state income tax withheld between quarterly returns.",
  },
  a4: {
    title: "Arizona A-4",
    body: "Arizona employee withholding election form. Lets the employee pick the flat rate applied to their state income tax.",
  },
  fica: {
    title: "FICA",
    body: "Federal Insurance Contributions Act. The combined Social Security (6.2%) and Medicare (1.45%) payroll tax, paid by both employee and employer.",
  },
  futa: {
    title: "FUTA",
    body: "Federal Unemployment Tax Act tax. Employer-only, 0.6% on the first $7,000 of each employee's wages after the state credit.",
  },
  suta: {
    title: "SUTA",
    body: "State Unemployment Tax. Employer-only contribution to the state unemployment insurance fund. Rate varies by employer experience.",
  },
  sdi: {
    title: "SDI",
    body: "State Disability Insurance. Funds short-term disability benefits in states that levy it. Arizona does not.",
  },
  ytd: {
    title: "Year to date",
    body: "Running total from January 1 through the current pay date. Used to enforce annual caps on Social Security, FUTA, and Additional Medicare.",
  },
  gross: {
    title: "Gross pay",
    body: "Total compensation earned for the period before any taxes or deductions are taken out.",
  },
  net: {
    title: "Net pay",
    body: "Take-home pay after all taxes and deductions. This is what gets sent to the employee's bank.",
  },
  schedule_b: {
    title: "Schedule B",
    body: "Attachment to Form 941 for semiweekly depositors. Lists federal tax liability by day across the quarter.",
  },
  schedule_a: {
    title: "Schedule A",
    body: "Section of the Arizona A-1-QRT for semiweekly depositors. Lists state income tax liability by pay date.",
  },
  finalized: {
    title: "Approved",
    body: "A pay run whose numbers have been locked. Approving updates YTD totals, freezes a snapshot for audit, and schedules tax deposits.",
  },
  deposit: {
    title: "Tax deposit",
    body: "A payment sent to the IRS or state for taxes withheld from a pay run. Not the same as paying the employee. Deposits have their own due dates based on your schedule.",
  },
  pay_run: {
    title: "Pay run",
    body: "One employee's paycheck for one pay period. A pay cycle typically produces one pay run per active employee.",
  },
  pay_cycle: {
    title: "Pay cycle",
    body: "A batch of pay runs for a single pay date. Employees on the same schedule share the same cycle.",
  },
  fit: {
    title: "Federal income tax",
    body: "Federal income tax withheld from the employee using the IRS Publication 15-T percentage method and the employee's W-4.",
  },
  sit: {
    title: "State income tax",
    body: "State income tax withheld based on the employee's state election. Arizona uses a flat rate the employee picks on Form A-4.",
  },
  semiweekly: {
    title: "Semiweekly depositor",
    body: "IRS schedule for employers with larger quarterly liabilities. Deposits are due a few business days after each payday.",
  },
  monthly_deposit: {
    title: "Monthly depositor",
    body: "IRS schedule for smaller employers. All 941 liability from a month is due by the 15th of the following month.",
  },
  fein: {
    title: "FEIN",
    body: "Federal Employer Identification Number. Nine-digit tax ID the IRS assigns to a business.",
  },
};

// ─── Convenience helpers ─────────────────────────────────────────────────────

export function runStatusLabel(status: RunStatus): string {
  return RUN_STATUS_HUMAN[status];
}

export function runStatusHelp(status: RunStatus): string {
  return RUN_STATUS_HELP[status];
}

export function depositStatusLabel(status: DepositStatus): string {
  return DEPOSIT_STATUS_HUMAN[status];
}

export function formStatusLabel(status: PayrollFormStatus): string {
  return FORM_STATUS_HUMAN[status];
}

export function glossary(slug: GlossarySlug): GlossaryEntry {
  return GLOSSARY[slug];
}
