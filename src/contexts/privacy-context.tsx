"use client";

import * as React from "react";

interface PrivacyContextType {
  isHidden: boolean;
  toggleHidden: () => void;
}

const PrivacyContext = React.createContext<PrivacyContextType | undefined>(undefined);

interface PrivacyProviderProps {
  children: React.ReactNode;
  /** Initial hidden state from server (read from cookie during SSR) */
  initialHidden?: boolean;
}

/**
 * Helper to set a cookie
 */
function setCookie(name: string, value: string, days: number = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${value}; expires=${expires}; path=/; SameSite=Lax`;
}

export function PrivacyProvider({ children, initialHidden = false }: PrivacyProviderProps) {
  // Initialize with the server-provided value so SSR renders correctly
  const [isHidden, setIsHidden] = React.useState<boolean>(initialHidden);

  // On mount, sync with DOM attribute (set by blocking script from localStorage)
  React.useEffect(() => {
    // Only override server value if localStorage explicitly set a value
    const domAttr = document.documentElement.getAttribute("data-hidden");
    if (domAttr !== null) {
      setIsHidden(domAttr === "true");
    }

    // Mark that React privacy system is now active
    // This allows CSS fallback rules to stop hiding values
    document.documentElement.setAttribute("data-privacy-ready", "true");

    // Listen for changes (from other components or tabs via storage event)
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === "data-hidden") {
          const newState = document.documentElement.getAttribute("data-hidden") === "true";
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
  }, []);

  const toggleHidden = React.useCallback(() => {
    const newState = !isHidden;
    setIsHidden(newState);
    // Store in localStorage for blocking script on next page load
    localStorage.setItem("data-hidden", String(newState));
    // Store in cookie for SSR on next page load
    setCookie("data-hidden", String(newState));
    // Update DOM attribute for CSS and cross-component sync
    document.documentElement.setAttribute("data-hidden", String(newState));
  }, [isHidden]);

  const contextValue = React.useMemo(
    () => ({
      isHidden,
      toggleHidden,
    }),
    [isHidden, toggleHidden]
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
