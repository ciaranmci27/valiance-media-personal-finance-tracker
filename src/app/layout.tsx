import type { Metadata } from "next";
import { siteConfig } from "@/config/site";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: `${siteConfig.companyName} Admin`,
    template: `%s | ${siteConfig.companyName} Admin`,
  },
  description: "Internal finance dashboard",
  robots: {
    index: false,
    follow: false,
  },
  icons: {
    icon: [
      { url: "/favicon/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    shortcut: "/favicon/favicon.ico",
    apple: "/favicon/apple-touch-icon.png",
  },
  manifest: "/favicon/site.webmanifest",
};

// Blocking script to prevent theme/data/layout flash - runs before any content renders
// Also handles migration from localStorage-only to cookie for SSR awareness
const initScript = `
(function() {
  try {
    // Theme preference
    var theme = localStorage.getItem('theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }

    // Privacy/hidden values preference
    var hidden = localStorage.getItem('data-hidden');
    if (hidden === 'true') {
      document.documentElement.setAttribute('data-hidden', 'true');
      if (document.cookie.indexOf('data-hidden=true') === -1) {
        document.cookie = 'data-hidden=true; path=/; max-age=31536000; SameSite=Lax';
      }
    } else if (hidden === 'false') {
      document.cookie = 'data-hidden=false; path=/; max-age=31536000; SameSite=Lax';
    }

    // Sidebar collapsed preference
    var sidebarCollapsed = localStorage.getItem('sidebar-collapsed');
    if (sidebarCollapsed === 'true') {
      document.documentElement.setAttribute('data-sidebar-collapsed', 'true');
      if (document.cookie.indexOf('sidebar-collapsed=true') === -1) {
        document.cookie = 'sidebar-collapsed=true; path=/; max-age=31536000; SameSite=Lax';
      }
    } else if (sidebarCollapsed === 'false') {
      document.documentElement.setAttribute('data-sidebar-collapsed', 'false');
      document.cookie = 'sidebar-collapsed=false; path=/; max-age=31536000; SameSite=Lax';
    }
  } catch (e) {}
})();
`;

// Critical CSS that hides financial values during the brief window between:
// 1. Blocking script setting data-hidden="true" (from localStorage)
// 2. React marking itself ready with data-privacy-ready="true"
// This handles the migration case where cookie doesn't exist yet
const privacyCriticalCSS = `
html[data-hidden="true"]:not([data-privacy-ready]) .currency,
html[data-hidden="true"]:not([data-privacy-ready]) td .font-mono,
html[data-hidden="true"]:not([data-privacy-ready]) .glass-card .font-mono {
  visibility: hidden !important;
}
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: initScript }} />
        <style dangerouslySetInnerHTML={{ __html: privacyCriticalCSS }} />
      </head>
      <body className="min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
