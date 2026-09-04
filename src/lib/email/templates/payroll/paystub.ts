/**
 * Pay stub email template.
 *
 * AZ ARS § 23-351(D) requires each employer to furnish each employee with
 * an itemized written or printed earnings statement each pay period showing
 * at minimum:
 *   - pay period dates
 *   - employer name and address
 *   - employee name
 *   - gross wages and rate of pay
 *   - hours worked (if applicable)
 *   - all deductions
 *
 * We send this email the moment a run is marked paid; `stub_sent_at` is the
 * durable proof of delivery.
 */

import type {
  OrganizationConfig,
  PayrollAddress,
  PayrollEmployee,
  PayrollRun,
  WithholdingLineItem,
} from "@/types/payroll";

import {
  EMAIL,
  FONT_MONO,
  accentPalette,
  emailLayout,
  escapeHtml,
  footerLine,
  heading,
  kvRows,
  label,
  metaLine,
  paragraph,
  tile,
} from "../shared";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PayStubYtdTotals {
  gross_pay: number;
  federal_income_tax: number;
  state_income_tax: number;
  social_security_employee: number;
  medicare_employee: number;
  additional_medicare: number;
  state_disability_employee: number;
  pre_tax_deductions: number;
  post_tax_deductions: number;
  net_pay: number;
}

export interface PayStubContext {
  run: PayrollRun;
  employee: PayrollEmployee;
  organization: OrganizationConfig;
  ytd: PayStubYtdTotals;
}

export interface BuiltEmail {
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

export function buildPayStubEmail(ctx: PayStubContext): BuiltEmail {
  const { run, employee, organization, ytd } = ctx;
  const employer = organization.legal_name;
  const periodLabel = formatPeriod(run.period_start, run.period_end);
  const payDateLabel = formatDate(run.pay_date);

  const subject = `${employer}: Pay stub for ${periodLabel}`;
  const preheader = `Net pay ${formatUSD(run.net_pay)} deposited ${payDateLabel}.`;

  const html = emailLayout({
    preheader,
    siteName: employer,
    body: renderHtmlBody({ run, employee, organization, ytd, periodLabel, payDateLabel }),
    footerHtml: renderFooter(organization),
  });

  const text = renderPlainText({ run, employee, organization, ytd, periodLabel, payDateLabel });

  return { subject, preheader, html, text };
}

// ─── HTML body ────────────────────────────────────────────────────────────────

interface RenderArgs extends PayStubContext {
  periodLabel: string;
  payDateLabel: string;
}

type Row = { label: string; value: string; strong?: boolean };

function renderHtmlBody(args: RenderArgs): string {
  const { run, employee, organization, ytd, periodLabel, payDateLabel } = args;

  const employeeName = `${employee.first_name} ${employee.last_name}`.trim();
  const rateOfPay = describeRateOfPay(employee);
  const teal = accentPalette();

  const netPay = tile(
    `${label("Net pay", { color: teal.bright })}<p style="margin: 0; font-family: ${FONT_MONO}; font-size: 32px; line-height: 1.1; font-weight: 300; letter-spacing: -0.02em; color: ${EMAIL.ink};">${escapeHtml(formatUSD(run.net_pay))}</p>`,
    { tone: "teal" },
  );

  const statement = kvRows([
    { label: "Employee", value: employeeName },
    { label: "Employer", value: organization.legal_name },
    { label: "Pay period", value: periodLabel },
    { label: "Pay date", value: payDateLabel },
  ]);

  const thisPeriod = kvRows([
    { label: "Gross pay", value: formatUSD(run.gross_pay), strong: true },
    ...(rateOfPay ? [{ label: "Rate of pay", value: rateOfPay }] : []),
    ...buildDeductionRows(run),
    { label: "Total deductions", value: formatUSD(totalDeductions(run)) },
    { label: "Net pay", value: formatUSD(run.net_pay), strong: true },
  ]);

  const yearToDate = kvRows([
    { label: "Gross", value: formatUSD(ytd.gross_pay) },
    { label: "Federal income tax", value: formatUSD(ytd.federal_income_tax) },
    { label: "State income tax", value: formatUSD(ytd.state_income_tax) },
    { label: "Social Security", value: formatUSD(ytd.social_security_employee) },
    { label: "Medicare", value: formatUSD(ytd.medicare_employee + ytd.additional_medicare) },
    ...(ytd.state_disability_employee > 0
      ? [{ label: "State disability", value: formatUSD(ytd.state_disability_employee) }]
      : []),
    ...(ytd.pre_tax_deductions > 0
      ? [{ label: "Pre-tax deductions", value: formatUSD(ytd.pre_tax_deductions) }]
      : []),
    ...(ytd.post_tax_deductions > 0
      ? [{ label: "Post-tax deductions", value: formatUSD(ytd.post_tax_deductions) }]
      : []),
    { label: "Net pay", value: formatUSD(ytd.net_pay), strong: true },
  ]);

  const runTypeNote =
    run.run_type === "off_cycle"
      ? paragraph("This is an off-cycle payment (bonus or supplemental).", { muted: true, size: 13 })
      : run.run_type === "correction"
        ? paragraph("This statement reflects a correction to a prior run.", { muted: true, size: 13 })
        : "";

  return [
    heading("Your pay stub is", "ready."),
    metaLine([organization.legal_name, periodLabel]),
    paragraph(
      `Hi ${escapeHtml(employee.first_name)}, your pay for the period <strong>${escapeHtml(periodLabel)}</strong> has been issued. Net pay was deposited on <strong>${escapeHtml(payDateLabel)}</strong>.`,
    ),
    runTypeNote,
    netPay,
    statement,
    label("This pay period"),
    thisPeriod,
    label("Year to date"),
    yearToDate,
    paragraph(
      "This is an automated earnings statement. Keep it for your records. If any detail looks incorrect, contact your employer right away.",
      { muted: true, size: 13 },
    ),
  ].join("");
}

/** Employer name and address, required on the statement, live in the footer. */
function renderFooter(organization: OrganizationConfig): string {
  const address = formatAddressInline(organization.address);
  const issuer = address ? `${organization.legal_name}, ${address}` : organization.legal_name;
  return [
    footerLine(`Issued by ${escapeHtml(issuer)}. This is an automated message; replies are not monitored.`),
    footerLine(`&copy; ${new Date().getFullYear()} ${escapeHtml(organization.legal_name)}`),
  ].join("");
}

// ─── Plain text body ──────────────────────────────────────────────────────────
// Some clients (and compliance archives) prefer text. Keep it parallel to HTML.

function renderPlainText(args: RenderArgs): string {
  const { run, employee, organization, ytd, periodLabel, payDateLabel } = args;
  const employeeName = `${employee.first_name} ${employee.last_name}`.trim();
  const employerAddress = formatAddressInline(organization.address);
  const rate = describeRateOfPay(employee);

  const lines: string[] = [];
  lines.push(`Pay stub for ${employeeName}`);
  lines.push("");
  lines.push(`Employer: ${organization.legal_name}`);
  if (employerAddress) lines.push(`          ${employerAddress}`);
  lines.push(`Employee: ${employeeName}`);
  lines.push(`Period:   ${periodLabel}`);
  lines.push(`Pay date: ${payDateLabel}`);
  lines.push("");
  lines.push("Earnings");
  lines.push(`  Gross pay:      ${formatUSD(run.gross_pay)}`);
  if (rate) lines.push(`  Rate of pay:    ${rate}`);
  lines.push("");
  lines.push("Deductions");
  for (const row of plainDeductionRows(run)) lines.push(`  ${row}`);
  lines.push(`  Total:          ${formatUSD(totalDeductions(run))}`);
  lines.push("");
  lines.push(`Net pay:          ${formatUSD(run.net_pay)}`);
  lines.push("");
  lines.push("Year to date");
  lines.push(`  Gross:          ${formatUSD(ytd.gross_pay)}`);
  lines.push(`  Federal tax:    ${formatUSD(ytd.federal_income_tax)}`);
  lines.push(`  State tax:      ${formatUSD(ytd.state_income_tax)}`);
  lines.push(`  Social Sec:     ${formatUSD(ytd.social_security_employee)}`);
  lines.push(`  Medicare:       ${formatUSD(ytd.medicare_employee + ytd.additional_medicare)}`);
  if (ytd.state_disability_employee > 0)
    lines.push(`  State SDI:      ${formatUSD(ytd.state_disability_employee)}`);
  if (ytd.pre_tax_deductions > 0)
    lines.push(`  Pre-tax:        ${formatUSD(ytd.pre_tax_deductions)}`);
  if (ytd.post_tax_deductions > 0)
    lines.push(`  Post-tax:       ${formatUSD(ytd.post_tax_deductions)}`);
  lines.push(`  Net pay:        ${formatUSD(ytd.net_pay)}`);
  lines.push("");
  lines.push("This is an automated earnings statement. Keep it for your records.");
  return lines.join("\n");
}

// ─── Deduction row builders ───────────────────────────────────────────────────

function buildDeductionRows(run: PayrollRun): Row[] {
  const rows: Row[] = [];

  if (run.federal_income_tax > 0)
    rows.push({ label: "Federal income tax", value: formatUSD(run.federal_income_tax) });
  if (run.state_income_tax > 0)
    rows.push({ label: "State income tax", value: formatUSD(run.state_income_tax) });
  if (run.social_security_employee > 0)
    rows.push({ label: "Social Security (6.2%)", value: formatUSD(run.social_security_employee) });
  if (run.medicare_employee > 0)
    rows.push({ label: "Medicare (1.45%)", value: formatUSD(run.medicare_employee) });
  if (run.additional_medicare > 0)
    rows.push({ label: "Additional Medicare (0.9%)", value: formatUSD(run.additional_medicare) });
  if (run.state_disability_employee > 0)
    rows.push({ label: "State disability", value: formatUSD(run.state_disability_employee) });

  for (const line of splitOtherWithholdings(run.other_withholdings)) {
    rows.push({ label: line.label, value: formatUSD(line.amount) });
  }

  return rows;
}

function plainDeductionRows(run: PayrollRun): string[] {
  const rows: string[] = [];
  if (run.federal_income_tax > 0)
    rows.push(`Federal tax:    ${formatUSD(run.federal_income_tax)}`);
  if (run.state_income_tax > 0)
    rows.push(`State tax:      ${formatUSD(run.state_income_tax)}`);
  if (run.social_security_employee > 0)
    rows.push(`Social Sec:     ${formatUSD(run.social_security_employee)}`);
  if (run.medicare_employee > 0)
    rows.push(`Medicare:       ${formatUSD(run.medicare_employee)}`);
  if (run.additional_medicare > 0)
    rows.push(`Addl Medicare:  ${formatUSD(run.additional_medicare)}`);
  if (run.state_disability_employee > 0)
    rows.push(`State SDI:      ${formatUSD(run.state_disability_employee)}`);
  for (const line of splitOtherWithholdings(run.other_withholdings)) {
    rows.push(`${line.label.padEnd(15)} ${formatUSD(line.amount)}`);
  }
  return rows;
}

function splitOtherWithholdings(list: WithholdingLineItem[] | null): WithholdingLineItem[] {
  if (!Array.isArray(list)) return [];
  return list.filter((w) => w && w.amount > 0);
}

function totalDeductions(run: PayrollRun): number {
  const other = Array.isArray(run.other_withholdings)
    ? run.other_withholdings.reduce((s, w) => s + (w?.amount || 0), 0)
    : 0;
  return (
    run.federal_income_tax +
    run.state_income_tax +
    run.social_security_employee +
    run.medicare_employee +
    run.additional_medicare +
    run.state_disability_employee +
    other
  );
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatUSD(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatPeriod(start: string, end: string): string {
  return `${formatDate(start)} - ${formatDate(end)}`;
}

function formatAddressInline(addr: PayrollAddress | Record<string, never> | null | undefined): string {
  if (!addr || !("line1" in addr)) return "";
  const parts = [addr.line1, addr.line2, `${addr.city}, ${addr.state} ${addr.zip}`].filter(
    (s): s is string => Boolean(s && s.trim()),
  );
  return parts.join(", ");
}

function describeRateOfPay(employee: PayrollEmployee): string {
  const amount = formatUSD(employee.pay_amount);
  switch (employee.pay_frequency) {
    case "weekly":
      return `${amount} per week`;
    case "biweekly":
      return `${amount} every two weeks`;
    case "semimonthly":
      return `${amount} twice per month`;
    case "monthly":
      return `${amount} per month`;
    case "annual":
      return `${amount} annually`;
    default:
      return amount;
  }
}
