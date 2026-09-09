"use client";

import * as React from "react";
import {
  MobileMenuButton,
  HeaderControls,
} from "@/components/layout/page-header";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, Check, Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Theme = "light" | "dark";

export function AppearanceSettingsContent() {
  const [theme, setTheme] = React.useState<Theme | null>(null);

  React.useEffect(() => {
    const currentTheme = document.documentElement.getAttribute(
      "data-theme",
    ) as Theme | null;
    setTheme(currentTheme === "light" ? "light" : "dark");

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === "data-theme") {
          const newTheme = document.documentElement.getAttribute(
            "data-theme",
          ) as Theme | null;
          setTheme(newTheme === "light" ? "light" : "dark");
        }
      });
    });
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);

  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
    localStorage.setItem("theme", newTheme);
    document.documentElement.setAttribute("data-theme", newTheme);
  };

  const displayTheme = theme ?? "dark";

  const themes: {
    value: Theme;
    label: string;
    description: string;
    image: string;
  }[] = [
    {
      value: "light",
      label: "Light",
      description: "Clean and bright interface",
      image: "/light.png",
    },
    {
      value: "dark",
      label: "Dark",
      description: "Easy on the eyes",
      image: "/dark.png",
    },
  ];

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-y-2">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-copper/10">
            <Palette className="h-5 w-5 text-copper" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Appearance</h1>
            <p className="text-sm text-muted-foreground">
              Customize how the dashboard looks
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/settings">
            <Button size="sm" className="rounded-xl gap-1">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          </Link>
          <HeaderControls />
        </div>
      </div>

      {/* Theme Section */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Theme
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>

        <div
          className={cn(
            "grid grid-cols-1 min-[440px]:grid-cols-2 gap-4",
            !theme && "opacity-0",
          )}
        >
          {themes.map((t) => {
            const isSelected = displayTheme === t.value;
            return (
              <button
                key={t.value}
                onClick={() => handleThemeChange(t.value)}
                className={cn(
                  "group relative glass-card glass-card-interactive rounded-xl p-5 text-left",
                  isSelected
                    ? "border-primary/50 bg-primary/5"
                    : "hover:border-primary/30 hover:scale-[1.01]",
                )}
              >
                {/* Selected indicator */}
                {isSelected && (
                  <div className="absolute top-3 right-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                    <Check className="h-3 w-3 text-primary-foreground" />
                  </div>
                )}

                {/* Inline image and text */}
                <div className="flex items-center gap-4">
                  <Image
                    src={t.image}
                    alt={t.label}
                    width={t.value === "light" ? 384 : 373}
                    height={377}
                    sizes="48px"
                    className="h-auto w-12 shrink-0"
                  />
                  <div>
                    <h3
                      className={cn(
                        "font-semibold transition-colors",
                        isSelected ? "text-teal-light" : "text-foreground",
                      )}
                    >
                      {t.label}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {t.description}
                    </p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Preview Section */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Preview
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>

        <div className="glass-card rounded-xl p-6">
          <div className="glass-card rounded-xl bg-white/[0.03] p-4">
            <div className="space-y-3">
              {/* Mock header */}
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-primary/20" />
                <div className="space-y-1.5 flex-1">
                  <div className="h-3 w-24 rounded bg-foreground/20" />
                  <div className="h-2 w-16 rounded bg-muted-foreground/20" />
                </div>
              </div>

              {/* Mock content */}
              <div className="h-px bg-border" />

              <div className="grid grid-cols-3 gap-2">
                <div className="h-16 rounded-lg bg-primary/10 flex items-center justify-center">
                  <div className="h-6 w-6 rounded bg-primary/30" />
                </div>
                <div className="h-16 rounded-lg bg-secondary flex items-center justify-center">
                  <div className="h-6 w-6 rounded bg-muted-foreground/20" />
                </div>
                <div className="h-16 rounded-lg bg-copper/10 flex items-center justify-center">
                  <div className="h-6 w-6 rounded bg-copper/30" />
                </div>
              </div>

              {/* Mock buttons */}
              <div className="flex gap-2 pt-2">
                <div className="h-8 w-20 rounded-lg bg-primary" />
                <div className="h-8 w-20 glass-card rounded-xl" />
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground text-center mt-4">
            Preview of your current theme
          </p>
        </div>
      </div>
    </div>
  );
}
