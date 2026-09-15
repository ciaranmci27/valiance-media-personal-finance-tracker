"use client";

import * as React from "react";

interface PrivacyContextType {
  isHidden: boolean;
  toggleHidden: () => void;
}

const PrivacyContext = React.createContext<PrivacyContextType | undefined>(
  undefined,
);

interface PrivacyProviderProps {
  children: React.ReactNode;
  /** The account's saved choice (team_members.privacy_hidden), resolved server-side. */
  initialHidden?: boolean;
  /** Saves the choice to the account. Absent in demo mode: the choice stays on the device. */
  persist?: (hidden: boolean) => Promise<unknown>;
}

/**
 * Helper to set a cookie
 */
function setCookie(name: string, value: string, days: number = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${value}; expires=${expires}; path=/; SameSite=Lax`;
}

/** The DOM attribute, cookie and localStorage mirror one value. */
function applyHidden(hidden: boolean) {
  document.documentElement.setAttribute("data-hidden", String(hidden));
  try {
    localStorage.setItem("data-hidden", String(hidden));
  } catch {
    /* Private mode: the account still remembers. */
  }
  setCookie("data-hidden", String(hidden));
}

/**
 * The privacy eye. The account is the source of truth so the choice follows
 * the person to every device; the cookie and localStorage are a mirror so the
 * root blocking script and the server render can hide figures before React
 * mounts. On mount the account value wins over whatever the device last had.
 */
export function PrivacyProvider({
  children,
  initialHidden = false,
  persist,
}: PrivacyProviderProps) {
  // Initialize with the server-provided value so SSR renders correctly
  const [isHidden, setIsHidden] = React.useState<boolean>(initialHidden);

  React.useEffect(() => {
    setIsHidden(initialHidden);
    applyHidden(initialHidden);

    // Mark that React privacy system is now active
    // This allows CSS fallback rules to stop hiding values
    document.documentElement.setAttribute("data-privacy-ready", "true");

    // Listen for changes (from other components or tabs via storage event)
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === "data-hidden") {
          const newState =
            document.documentElement.getAttribute("data-hidden") === "true";
          setIsHidden(newState);
        }
      });
    });
    observer.observe(document.documentElement, { attributes: true });

    // Also listen for storage changes from other tabs
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "data-hidden") {
        const newState = e.newValue === "true";
        setIsHidden(newState);
        document.documentElement.setAttribute("data-hidden", String(newState));
      }
    };
    window.addEventListener("storage", handleStorage);

    return () => {
      observer.disconnect();
      window.removeEventListener("storage", handleStorage);
    };
  }, [initialHidden]);

  const toggleHidden = React.useCallback(() => {
    const newState = !isHidden;
    setIsHidden(newState);
    applyHidden(newState);
    // The account keeps the choice; a failed save leaves the device as it is
    // and the next load restores the saved value.
    void persist?.(newState).catch(() => undefined);
  }, [isHidden, persist]);

  const contextValue = React.useMemo(
    () => ({
      isHidden,
      toggleHidden,
    }),
    [isHidden, toggleHidden],
  );

  return (
    <PrivacyContext.Provider value={contextValue}>
      {children}
    </PrivacyContext.Provider>
  );
}

export function usePrivacy() {
  const context = React.useContext(PrivacyContext);
  if (context === undefined) {
    throw new Error("usePrivacy must be used within a PrivacyProvider");
  }
  return context;
}
