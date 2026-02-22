/**
 * Site Configuration
 *
 * Update these values to customize the dashboard for your company.
 * This is the single source of truth for branding throughout the app.
 */

export const siteConfig = {
  /** Your first and last name */
  realName: "Ciaran Mcintyre",

  /** Company name displayed in headers, titles, and branding */
  companyName: "Valiance Media",

  /**
   * Logo paths - replace the actual image files in /public to rebrand.
   * Only change these paths if you use different filenames.
   */
  logos: {
    /** Horizontal logo for light backgrounds */
    horizontal: "/logos/horizontal-logo.png",
    /** Horizontal logo for dark backgrounds */
    horizontalInverted: "/logos/horizontal-logo-inverted.png",
    /** Square icon for collapsed sidebar and favicons */
    icon: "/favicon/android-chrome-192x192.png",
  },
} as const;

/**
 * Theme colors are defined in src/app/globals.css as CSS custom properties.
 * To change colors, edit the CSS variables there:
 *
 * --primary: #5B8A8A (teal)
 * --secondary: #C5A68F (copper)
 * --background: #F5F3EF (light theme)
 */

export type SiteConfig = typeof siteConfig;
