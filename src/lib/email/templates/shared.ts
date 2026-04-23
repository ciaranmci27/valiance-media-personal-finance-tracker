/**
 * Shared email utilities: brand-consistent layout wrapper, CTA helpers, and
 * HTML escaping. All Valiance Media email templates import from this file.
 *
 * Design notes:
 *   - Email clients strip/ignore most modern CSS. Everything inline, tables
 *     for layout, web-safe font stacks only.
 *   - Plus Jakarta Sans is our brand font but virtually no email client
 *     loads web fonts; we rely on the stack degrading cleanly to system
 *     sans-serif.
 */

export const BRAND = {
  teal: "#5B8A8A",
  tealDark: "#406666",
  copper: "#C5A68F",
  copperDark: "#a6896f",
  cream: "#F5F3EF",
  white: "#ffffff",
  textDark: "#1a1a1a",
  textMuted: "#6b7280",
  border: "#e5e7eb",
  pageBg: "#ece9e3",
} as const;

export const EMAIL_FONT_STACK =
  "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

export function getSiteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || "https://admin.valiancemedia.com";
}

/** Escape HTML special characters. Use for any dynamic text in templates. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Format a number as USD. Used across payroll email templates. */
export function formatUSD(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Teal CTA button. Uses a bottom-border trick for an email-safe shadow. */
export function ctaButton(text: string, href: string): string {
  const url = href.startsWith("http") ? href : `${getSiteUrl()}${href}`;
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px 0;">
      <tr>
        <td style="
          background-color: ${BRAND.teal};
          border-radius: 8px;
          border-bottom: 3px solid ${BRAND.tealDark};
          padding: 14px 36px;
        ">
          <a href="${url}" target="_blank" style="
            color: ${BRAND.white};
            font-family: ${EMAIL_FONT_STACK};
            font-size: 16px;
            font-weight: 600;
            text-decoration: none;
            display: inline-block;
          ">${escapeHtml(text)}</a>
        </td>
      </tr>
    </table>
  `;
}

interface LayoutOptions {
  preheader?: string;
  body: string;
  /** Override the default company name in the footer. */
  companyName?: string;
}

/**
 * Wrap email body HTML in the Valiance-branded shell.
 * `body` is injected verbatim so callers are responsible for escaping.
 */
export function emailLayout({ preheader, body, companyName = "Valiance Media" }: LayoutOptions): string {
  const siteUrl = getSiteUrl();
  const year = new Date().getFullYear();

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(companyName)}</title>
</head>
<body style="
  margin: 0;
  padding: 0;
  background-color: ${BRAND.pageBg};
  font-family: ${EMAIL_FONT_STACK};
  -webkit-font-smoothing: antialiased;
">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${BRAND.pageBg};">${escapeHtml(preheader)}</div>` : ""}

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${BRAND.pageBg};">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="
          max-width: 600px;
          width: 100%;
          border: 1px solid ${BRAND.border};
          border-radius: 12px;
          overflow: hidden;
        ">

          <!-- Header -->
          <tr>
            <td align="center" style="
              background-color: ${BRAND.teal};
              padding: 28px 40px;
              border-bottom: 2px solid ${BRAND.copper};
              text-align: center;
            ">
              <span style="
                font-family: ${EMAIL_FONT_STACK};
                font-size: 22px;
                font-weight: 700;
                color: ${BRAND.white};
                letter-spacing: -0.3px;
              ">${escapeHtml(companyName)}</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="
              background-color: ${BRAND.white};
              padding: 36px 40px;
              color: ${BRAND.textDark};
              font-family: ${EMAIL_FONT_STACK};
              font-size: 16px;
              line-height: 1.65;
            ">
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="
              background-color: ${BRAND.cream};
              padding: 20px 40px;
              border-top: 1px solid ${BRAND.border};
            ">
              <p style="
                margin: 0;
                font-family: ${EMAIL_FONT_STACK};
                font-size: 12px;
                color: ${BRAND.textMuted};
                line-height: 1.6;
                text-align: center;
              ">
                &copy; ${year} <a href="${siteUrl}" style="color: ${BRAND.teal}; text-decoration: none; font-weight: 500;">${escapeHtml(companyName)}</a>. This is an automated message, please do not reply.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/** Render a heading inside the body slot. Matches brand typography. */
export function heading(text: string): string {
  return `
    <h1 style="
      margin: 0 0 16px 0;
      font-family: ${EMAIL_FONT_STACK};
      font-size: 22px;
      font-weight: 700;
      color: ${BRAND.textDark};
      letter-spacing: -0.3px;
    ">${escapeHtml(text)}</h1>
  `;
}

/** Render a paragraph. Accepts pre-rendered HTML so use escapeHtml upstream. */
export function paragraph(html: string): string {
  return `
    <p style="
      margin: 0 0 16px 0;
      font-family: ${EMAIL_FONT_STACK};
      font-size: 16px;
      line-height: 1.65;
      color: ${BRAND.textDark};
    ">${html}</p>
  `;
}

/** Muted helper text, for small print under primary content. */
export function mutedText(html: string): string {
  return `
    <p style="
      margin: 0 0 12px 0;
      font-family: ${EMAIL_FONT_STACK};
      font-size: 13px;
      line-height: 1.6;
      color: ${BRAND.textMuted};
    ">${html}</p>
  `;
}

/** Key-value row used inside summary tables (e.g. earnings breakdown). */
export function kvRow(label: string, value: string, opts?: { bold?: boolean; divider?: boolean }): string {
  const weight = opts?.bold ? "600" : "400";
  const borderTop = opts?.divider ? `border-top: 2px solid ${BRAND.border};` : "";
  return `
    <tr>
      <td style="
        padding: 8px 0;
        ${borderTop}
        font-family: ${EMAIL_FONT_STACK};
        font-size: 14px;
        color: ${BRAND.textDark};
        font-weight: ${weight};
      ">${escapeHtml(label)}</td>
      <td align="right" style="
        padding: 8px 0;
        ${borderTop}
        font-family: ${EMAIL_FONT_STACK};
        font-size: 14px;
        color: ${BRAND.textDark};
        font-weight: ${weight};
        font-variant-numeric: tabular-nums;
      ">${escapeHtml(value)}</td>
    </tr>
  `;
}

/** Wrap kvRow entries in a two-column table. */
export function summaryTable(rows: string): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="
      margin: 16px 0 24px 0;
      background-color: ${BRAND.cream};
      border-radius: 8px;
      padding: 12px 20px;
      box-sizing: border-box;
    ">
      ${rows}
    </table>
  `;
}
