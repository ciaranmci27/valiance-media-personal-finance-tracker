"use client";

import { useInsertionEffect } from "react";

/**
 * The signed-in account's theme wins over whatever this device last used.
 * The root layout's blocking script only knows localStorage, so on a fresh
 * device, and on the client-side route change after signing in, this applies
 * the account's choice. An insertion effect runs before any layout effect
 * and before the browser paints the hydrated tree, so nothing reads the old
 * value first. An inline script cannot do this: React never executes one on
 * a client-side render.
 */
export function AccountTheme({ theme }: { theme: "light" | "dark" | null }) {
  useInsertionEffect(() => {
    if (!theme) return;
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* Private mode: the account still remembers. */
    }
  }, [theme]);
  return null;
}
