/**
 * Shared email language: layout wrapper, building blocks, and escaping.
 * Every email template imports from this file.
 *
 * The look is the marketing site's (website/src/styles/site.css) made
 * email-safe: near-black canvas, one dark card, cream ink, teal as light,
 * copper for the warm accent, DM Sans / DM Mono / Instrument Serif with
 * system fallbacks. Tables and inline styles only; no gradients or blur,
 * solid hex everywhere so Outlook and Gmail agree on what they see.
 *
 * The same file lives in `website` and `admin` with only the WORKSPACE
 * block at the top adapted. Keep the rest byte-identical across the three
 * so the brand reads the same from every sender.
 */

// ─── WORKSPACE: the only part that differs between app / website / admin ──────

export function getSiteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || 'https://admin.valiancemedia.com';
}

/** Default sender name. Pay stubs override it per email with `siteName`. */
export function getSiteName(): string {
  return 'Valiance Media';
}

/** The lockup drawn for dark chrome, served from the marketing site. */
export function getLogoSrc(): string {
  return 'https://valiancemedia.com/logos/horizontal-logo-inverted.png';
}

/** Brand teal. Every teal tint in an email derives from this one hex. */
export function brandPrimary(): string {
  return '#5B8A8A';
}

// ─── Palette ──────────────────────────────────────────────────────────────────

/** Fixed neutrals and the copper accent. Teal tints derive from `brandPrimary()`. */
export const EMAIL = {
  canvas: '#08090C',
  card: '#0D0F14',
  tile: '#12141A',
  border: '#1F2229',
  borderStrong: '#2A2E36',
  ink: '#F5F3EF',
  body: '#C9C7C2',
  muted: '#8F8E8A',
  faint: '#6E6D69',
  copper: '#C5A68F',
  copper300: '#D4BBA8',
  copperTile: '#322D2D',
  copperBorder: '#60534B',
  error: '#F0A3A3',
  errorTile: '#2E1E1E',
  errorBorder: '#5A3A3A',
} as const;

/**
 * @deprecated Kept so older templates compile. Semantic names, dark values:
 * `white` is the card surface, `black` is strong text.
 */
export const NEUTRAL = {
  white: EMAIL.card,
  black: EMAIL.ink,
  textBody: EMAIL.body,
  textMuted: EMAIL.muted,
  border: EMAIL.border,
  bgOuter: EMAIL.canvas,
};

export const FONT_SANS =
  "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const FONT_MONO = "'DM Mono', 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace";
export const FONT_SERIF = "'Instrument Serif', Georgia, 'Times New Roman', serif";

// ─── Colour math ──────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mix `a` toward `b` by `t` (0 to 1), in sRGB. */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

export function darkenHex(hex: string, factor: number): string {
  return mixHex(hex, '#000000', factor);
}

export function lightenHex(hex: string, factor: number): string {
  return mixHex(hex, EMAIL.ink, factor);
}

/** Every teal-derived value an email needs, from the brand teal. */
export function accentPalette() {
  const base = brandPrimary();
  return {
    base,
    /** Text and icons on dark: the site's teal-300. */
    bright: mixHex(base, EMAIL.ink, 0.35),
    /** Button fill: the site's teal-200. */
    pale: mixHex(base, EMAIL.ink, 0.55),
    /** Tinted surface and its border. */
    tile: mixHex(base, EMAIL.card, 0.78),
    border: mixHex(base, EMAIL.card, 0.55),
  };
}

/** @deprecated Use accentPalette().bright. */
export function brandLight(): string {
  return accentPalette().bright;
}

/** @deprecated Use accentPalette().tile. */
export function brandSubtle(): string {
  return accentPalette().tile;
}

// ─── Escaping ─────────────────────────────────────────────────────────────────

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Site-relative paths get the site origin; full URLs, mailto: and tel: pass through. */
export function absoluteUrl(href: string): string {
  return /^(https?:|mailto:|tel:)/i.test(href) ? href : `${getSiteUrl()}${href}`;
}

// ─── Building blocks ──────────────────────────────────────────────────────────
// Each returns a fragment for the card body. Arguments named `html` are
// trusted markup; everything else is escaped here.

type Tone = 'teal' | 'copper' | 'error' | 'neutral';

function toneColors(tone: Tone) {
  const teal = accentPalette();
  if (tone === 'teal') return { text: teal.bright, tile: teal.tile, border: teal.border };
  if (tone === 'copper') return { text: EMAIL.copper300, tile: EMAIL.copperTile, border: EMAIL.copperBorder };
  if (tone === 'error') return { text: EMAIL.error, tile: EMAIL.errorTile, border: EMAIL.errorBorder };
  return { text: EMAIL.body, tile: EMAIL.tile, border: EMAIL.border };
}

/**
 * The title. Plain sans with an optional serif italic tail in copper, the
 * way the site's section headings end: `heading('Invoice 1042 is', 'ready.')`.
 */
export function heading(text: string, accentTail?: string): string {
  const tail = accentTail
    ? ` <em style="font-family: ${FONT_SERIF}; font-style: italic; font-weight: 400; letter-spacing: -0.01em; color: ${EMAIL.copper300};">${escapeHtml(accentTail)}</em>`
    : '';
  return `<h1 style="margin: 0 0 14px 0; font-family: ${FONT_SANS}; font-size: 27px; line-height: 1.15; font-weight: 500; letter-spacing: -0.02em; color: ${EMAIL.ink};">${escapeHtml(text)}${tail}</h1>`;
}

/** Body copy. Pass trusted `html` (already escaped where needed). */
export function paragraph(html: string, options: { muted?: boolean; size?: number } = {}): string {
  const color = options.muted ? EMAIL.muted : EMAIL.body;
  const size = options.size ?? 15;
  return `<p style="margin: 0 0 16px 0; font-family: ${FONT_SANS}; font-size: ${size}px; line-height: 1.65; color: ${color};">${html}</p>`;
}

/** Small mono caption for data: field names, table heads, timestamps. */
export function label(text: string, options: { color?: string; margin?: string } = {}): string {
  return `<p style="margin: ${options.margin ?? '0 0 6px 0'}; font-family: ${FONT_MONO}; font-size: 11px; line-height: 1.4; letter-spacing: 0.14em; text-transform: uppercase; color: ${options.color ?? EMAIL.muted};">${escapeHtml(text)}</p>`;
}

/** One mono line of facts, dot-separated: `metaLine(['Invoice 1042', 'Due Oct 14'])`. */
export function metaLine(items: string[]): string {
  const joined = items.filter(Boolean).map(escapeHtml).join(' &nbsp;&middot;&nbsp; ');
  return `<p style="margin: 0 0 22px 0; font-family: ${FONT_MONO}; font-size: 12px; line-height: 1.5; letter-spacing: 0.04em; color: ${EMAIL.muted};">${joined}</p>`;
}

/** A thin rule with breathing room. */
export function hairline(margin = '24px 0'): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: ${margin};"><tr><td style="height: 1px; line-height: 1px; font-size: 1px; background-color: ${EMAIL.border};">&nbsp;</td></tr></table>`;
}

/** An inline pill in the mono caption style. */
export function chip(text: string, tone: Tone = 'neutral'): string {
  const c = toneColors(tone);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="display: inline-table;"><tr><td style="padding: 4px 10px; border-radius: 999px; border: 1px solid ${c.border}; background-color: ${c.tile}; font-family: ${FONT_MONO}; font-size: 11px; line-height: 1.3; letter-spacing: 0.08em; text-transform: uppercase; color: ${c.text}; white-space: nowrap;">${escapeHtml(text)}</td></tr></table>`;
}

/** A quieter inner surface for grouped content. */
export function tile(html: string, options: { tone?: Tone; padding?: string; margin?: string } = {}): string {
  const c = toneColors(options.tone ?? 'neutral');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: ${options.margin ?? '0 0 16px 0'};">
      <tr>
        <td style="padding: ${options.padding ?? '18px 20px'}; border-radius: 14px; border: 1px solid ${c.border}; background-color: ${c.tile};">
          ${html}
        </td>
      </tr>
    </table>`;
}

/**
 * A row of numbers that should read at a glance. Up to three across; on
 * narrow screens the cells stack because each is its own table.
 */
export function statGrid(stats: Array<{ label: string; value: string; tone?: Tone }>): string {
  const width = Math.floor(100 / Math.max(1, Math.min(stats.length, 3)));
  const cells = stats
    .map((stat, index) => {
      const c = toneColors(stat.tone ?? 'neutral');
      const valueColor = stat.tone && stat.tone !== 'neutral' ? c.text : EMAIL.ink;
      return `
        <td class="vm-stat-cell" width="${width}%" style="padding: ${index === 0 ? '0 6px 0 0' : index === stats.length - 1 ? '0 0 0 6px' : '0 6px'}; vertical-align: top;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding: 16px 16px 14px 16px; border-radius: 14px; border: 1px solid ${EMAIL.border}; background-color: ${EMAIL.tile};">
                ${label(stat.label)}
                <p style="margin: 0; font-family: ${FONT_MONO}; font-size: 24px; line-height: 1.1; font-weight: 300; letter-spacing: -0.02em; color: ${valueColor};">${escapeHtml(stat.value)}</p>
              </td>
            </tr>
          </table>
        </td>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 16px 0;"><tr>${cells}</tr></table>`;
}

/** Label on the left, value on the right, hairlines between. */
export function kvRows(rows: Array<{ label: string; value: string; strong?: boolean }>): string {
  const body = rows
    .map(
      (row, index) => `
      <tr>
        <td style="padding: 11px 0; ${index > 0 ? `border-top: 1px solid ${EMAIL.border};` : ''} font-family: ${FONT_MONO}; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: ${EMAIL.muted}; vertical-align: middle;">${escapeHtml(row.label)}</td>
        <td align="right" style="padding: 11px 0; ${index > 0 ? `border-top: 1px solid ${EMAIL.border};` : ''} font-family: ${FONT_SANS}; font-size: 14px; font-weight: ${row.strong ? 600 : 500}; color: ${EMAIL.ink}; vertical-align: middle; text-align: right;">${escapeHtml(row.value)}</td>
      </tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 16px 0;">${body}</table>`;
}

/** A progress track with a teal (or copper, past a limit) fill. */
export function progressBar(percent: number, options: { tone?: Tone; margin?: string } = {}): string {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const c = toneColors(options.tone ?? 'teal');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: ${options.margin ?? '0 0 16px 0'};">
      <tr>
        <td style="border-radius: 999px; background-color: ${EMAIL.borderStrong}; font-size: 0; line-height: 0;">
          <table role="presentation" width="${pct}%" cellpadding="0" cellspacing="0" style="width: ${pct}%;">
            <tr><td style="height: 6px; border-radius: 999px; background-color: ${c.text}; font-size: 0; line-height: 0;">&nbsp;</td></tr>
          </table>
        </td>
      </tr>
    </table>`;
}

/** A quote or note the sender wrote, in the serif face. */
export function pullQuote(html: string): string {
  return tile(
    `<p style="margin: 0; font-family: ${FONT_SERIF}; font-style: italic; font-size: 19px; line-height: 1.45; color: ${EMAIL.ink};">${html}</p>`,
    { padding: '20px 22px' },
  );
}

/**
 * The call to action, the same pill as the website button. Outlook gets a VML
 * rounded rectangle so the shape survives there.
 */
export function ctaButton(text: string, href: string, options: { margin?: string } = {}): string {
  const url = absoluteUrl(href);
  const safeText = escapeHtml(text);
  const safeUrl = escapeHtml(url);
  // The website button: a teal gradient pill with dark text and an arrow. Clients
  // that drop gradients (Outlook, some webmail) fall back to the solid teal-300.
  const fill = "#8DB3B3";
  const gradient = "linear-gradient(180deg, #A3C4C4 0%, #5B8A8A 100%)";
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: ${options.margin ?? "8px 0 24px 0"};">
      <tr>
        <td align="center" bgcolor="${fill}" style="border-radius: 999px; background-color: ${fill}; background-image: ${gradient}; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), inset 0 -1px 0 rgba(0, 0, 0, 0.18); mso-padding-alt: 0;">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeUrl}" style="height: 48px; v-text-anchor: middle; width: 240px;" arcsize="50%" stroke="f" fillcolor="${fill}">
            <w:anchorlock/>
            <center style="color: ${EMAIL.canvas}; font-family: Arial, sans-serif; font-size: 15px; font-weight: 600;">${safeText} &#8599;&#65038;</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-->
          <a href="${safeUrl}" target="_blank" style="display: inline-block; padding: 15px 26px 15px 30px; border-radius: 999px; font-family: ${FONT_SANS}; font-size: 15px; font-weight: 600; letter-spacing: -0.005em; line-height: 1.2; color: ${EMAIL.canvas}; text-decoration: none;">${safeText}<span style="display: inline-block; margin-left: 8px; font-family: Arial, sans-serif; font-weight: 400;">&#8599;&#65038;</span></a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>`;
}

/** The plain link under a button, for clients whose mail strips buttons. */
export function linkLine(href: string, text?: string): string {
  const url = absoluteUrl(href);
  const safeUrl = escapeHtml(url);
  return `<p style="margin: 0 0 16px 0; font-family: ${FONT_MONO}; font-size: 12px; line-height: 1.6; color: ${EMAIL.faint}; word-break: break-all;">${text ? escapeHtml(text) + ' ' : ''}<a href="${safeUrl}" style="color: ${accentPalette().bright}; text-decoration: underline;">${safeUrl}</a></p>`;
}

/** A footer line. Links render in teal. */
export function footerLine(html: string): string {
  return `<p style="margin: 0 0 6px 0; font-family: ${FONT_SANS}; font-size: 12px; line-height: 1.6; color: ${EMAIL.muted};">${html}</p>`;
}

export function footerLink(href: string, text: string): string {
  const url = absoluteUrl(href);
  return `<a href="${escapeHtml(url)}" style="color: ${accentPalette().bright}; text-decoration: none;">${escapeHtml(text)}</a>`;
}

// ─── Layout ───────────────────────────────────────────────────────────────────

/**
 * Wrap a body fragment in the branded email: lockup above, one dark card,
 * footer below. Width 600, dark canvas declared as the email's colour
 * scheme so clients do not try to invert it.
 */
export function emailLayout(options: {
  preheader?: string;
  body: string;
  footerHtml?: string;
  /** Sender name for the lockup alt, title, and footer. Pay stubs pass the employer. */
  siteName?: string;
  /**
   * Where the lockup links to.
   * - `undefined` (default): the site URL. Team and internal emails.
   * - `string`: that URL. Client emails point at the project portal.
   * - `null`: no link. Client emails for projects with no portal, so nobody
   *   is sent to an app they cannot log into.
   */
  logoHref?: string | null;
}): string {
  const { preheader, body, footerHtml, logoHref, siteName } = options;
  const siteUrl = getSiteUrl();
  const name = siteName ?? getSiteName();
  const teal = accentPalette();
  const resolvedLogoHref = logoHref === undefined ? siteUrl : logoHref;
  const safeName = escapeHtml(name);

  const lockup = `<img src="${getLogoSrc()}" alt="${safeName}" height="30" style="display: block; border: 0; outline: none; height: 30px; width: auto; max-width: 220px; color: ${EMAIL.ink}; font-family: ${FONT_SANS}; font-size: 18px; font-weight: 600;" />`;

  const defaultFooter = `
    ${footerLine('You received this because email notifications are enabled in your account.')}
    ${footerLine(`${footerLink('/settings', 'Manage notification preferences')} &nbsp;&middot;&nbsp; &copy; ${new Date().getFullYear()} ${footerLink(siteUrl, name)}`)}`;

  return `
<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>${safeName}</title>
  <!--[if !mso]><!-->
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&family=Instrument+Serif:ital@1&display=swap" rel="stylesheet" />
  <!--<![endif]-->
  <!--[if mso]>
  <xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
  <style>table, td { font-family: Arial, sans-serif !important; }</style>
  <![endif]-->
  <style>
    :root { color-scheme: dark; supported-color-schemes: dark; }
    body { margin: 0; padding: 0; background-color: ${EMAIL.canvas}; }
    a { color: ${teal.bright}; }
    @media only screen and (max-width: 620px) {
      .vm-card { padding: 28px 22px 26px 22px !important; }
      .vm-outer { padding: 24px 12px !important; }
      .vm-stat-cell { display: block !important; width: 100% !important; padding: 0 0 10px 0 !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: ${EMAIL.canvas}; font-family: ${FONT_SANS}; -webkit-font-smoothing: antialiased;">
  ${preheader ? `<div style="display: none; max-height: 0; overflow: hidden; font-size: 1px; line-height: 1px; color: ${EMAIL.canvas}; mso-hide: all;">${escapeHtml(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>` : ''}

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${EMAIL.canvas}" style="background-color: ${EMAIL.canvas};">
    <tr>
      <td align="center" class="vm-outer" style="padding: 40px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">

          <!-- Lockup -->
          <tr>
            <td align="left" style="padding: 0 10px 22px 10px;">
              ${resolvedLogoHref ? `<a href="${escapeHtml(resolvedLogoHref)}" target="_blank" style="text-decoration: none; display: inline-block;">${lockup}</a>` : lockup}
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td class="vm-card" bgcolor="${EMAIL.card}" style="background-color: ${EMAIL.card}; border: 1px solid ${EMAIL.border}; border-radius: 20px; padding: 40px 40px 34px 40px; color: ${EMAIL.body}; font-family: ${FONT_SANS}; font-size: 15px; line-height: 1.65;">
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding: 24px 10px 0 10px; text-align: center;">
              ${footerHtml || defaultFooter}
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
