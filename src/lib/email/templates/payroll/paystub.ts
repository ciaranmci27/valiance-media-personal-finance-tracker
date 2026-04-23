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
  BRAND,
  EMAIL_FONT_STACK,
  emailLayout,
  escapeHtml,
  formatUSD,
  heading,
  kvRow,
  mutedText,
  paragraph,
  summaryTable,
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
    companyName: employer,
    body: renderHtmlBody({ run, employee, organization, ytd, periodLabel, payDateLabel }),
  });

  const text = renderPlainText({ run, employee, organization, ytd, periodLabel, payDateLabel });

  return { subject, preheader, html, text };
}

// ─── HTML body ────────────────────────────────────────────────────────────────

interface RenderArgs extends PayStubContext {
  periodLabel: string;
  payDateLabel: string;
}

function renderHtmlBody(args: RenderArgs): string {
  const { run, employee, organization, ytd, periodLabel, payDateLabel } = args;

  const employeeName = `${employee.first_name} ${employee.last_name}`.trim();
  const rateOfPay = describeRateOfPay(employee);
  const employerAddress = formatAddressInline(organization.address);

  const earnings = summaryTable(
    [
      kvRow("Gross pay", formatUSD(run.gross_pay), { bold: true }),
      rateOfPay ? kvRow("Rate of pay", rateOfPay) : "",
    ].join(""),
  );

  const deductionRows = buildDeductionRows(run);
  const deductions = summaryTable(
    [
      ...deductionRows,
      kvRow("Total deductions", formatUSD(totalDeductions(run)), { bold: true, divider: true }),
    ].join(""),
  );

  const netRow = summaryTable(kvRow("Net pay", formatUSD(run.net_pay), { bold: true }));

  const ytdRows = summaryTable(
    [
      kvRow("YTD gross", formatUSD(ytd.gross_pay)),
      kvRow("YTD federal income tax", formatUSD(ytd.federal_income_tax)),
      kvRow("YTD state income tax", formatUSD(ytd.state_income_tax)),
      kvRow(
        "YTD Social Security",
        formatUSD(ytd.social_security_employee),
      ),
      kvRow(
        "YTD Medicare",
        formatUSD(ytd.medicare_employee + ytd.additional_medicare),
      ),
      ytd.state_disability_employee > 0
        ? kvRow("YTD state disability", formatUSD(ytd.state_disability_employee))
        : "",
      ytd.pre_tax_deductions > 0
        ? kvRow("YTD pre-tax deductions", formatUSD(ytd.pre_tax_deductions))
        : "",
      ytd.post_tax_deductions > 0
        ? kvRow("YTD post-tax deductions", formatUSD(ytd.post_tax_deductions))
        : "",
      kvRow("YTD net pay", formatUSD(ytd.net_pay), { bold: true, divider: true }),
    ].join(""),
  );

  const runTypeNote =
    run.run_type === "off_cycle"
      ? mutedText("This is an off-cycle payment (bonus or supplemental).")
      : run.run_type === "correction"
      ? mutedText("This statement reflects a correction to a prior run.")
      : "";

  return [
    heading("Your pay stub"),
    paragraph(
      `Hi ${escapeHtml(employee.first_name)}, your pay for the period <strong>${escapeHtml(periodLabel)}</strong> has been issued. Net pay was deposited on <strong>${escapeHtml(payDateLabel)}</strong>.`,
    ),
    runTypeNote,

    sectionLabel("Employer"),
    paragraph(
      `<strong>${escapeHtml(organization.legal_name)}</strong>${employerAddress ? `<br/>${escapeHtml(employerAddress)}` : ""}`,
    ),

    sectionLabel("Employee"),
    paragraph(`<strong>${escapeHtml(employeeName)}</strong>`),

    sectionLabel("Pay period"),
    paragraph(
      `${escapeHtml(periodLabel)}<br/>Pay date: ${escapeHtml(payDateLabel)}`,
    ),

    sectionLabel("Earnings"),
    earnings,

    sectionLabel("Deductions and withholdings"),
    deductions,

    sectionLabel("Net pay"),
    netRow,

    sectionLabel("Year to date"),
    ytdRows,

    mutedText(
      "This is an automated earnings statement. Keep it for your records. If any detail looks incorrect, contact your employer right away.",
    ),
  ].join("");
}

function sectionLabel(label: string): string {
  return `
    <p style="
      margin: 24px 0 6px 0;
      font-family: ${EMAIL_FONT_STACK};
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: ${BRAND.tealDark};
    ">${escapeHtml(label)}</p>
  `;
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

function buildDeductionRows(run: PayrollRun): string[] {
  const rows: string[] = [];

  if (run.federal_income_tax > 0)
    rows.push(kvRow("Federal income tax", formatUSD(run.federal_income_tax)));
  if (run.state_income_tax > 0)
    rows.push(kvRow("State income tax", formatUSD(run.state_income_tax)));
  if (run.social_security_employee > 0)
    rows.push(kvRow("Social Security (6.2%)", formatUSD(run.social_security_employee)));
  if (run.medicare_employee > 0)
    rows.push(kvRow("Medicare (1.45%)", formatUSD(run.medicare_employee)));
  if (run.additional_medicare > 0)
    rows.push(kvRow("Additional Medicare (0.9%)", formatUSD(run.additional_medicare)));
  if (run.state_disability_employee > 0)
    rows.push(kvRow("State disability", formatUSD(run.state_disability_employee)));

  for (const line of splitOtherWithholdings(run.other_withholdings)) {
    rows.push(kvRow(line.label, formatUSD(line.amount)));
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
