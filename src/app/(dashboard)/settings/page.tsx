import Link from "next/link";
import {
  User,
  Palette,
  Database,
  Trash2,
  ChevronRight,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const metadata = {
  title: "Settings",
};

const settingsSections = [
  {
    title: "Preferences",
    items: [
      {
        title: "Account",
        description: "Email, password, and security",
        href: "/settings/account",
        icon: User,
        iconBg: "bg-primary/10",
        iconColor: "text-primary",
      },
      {
        title: "Appearance",
        description: "Theme and display customization",
        href: "/settings/appearance",
        icon: Palette,
        iconBg: "bg-[#C5A68F]/10",
        iconColor: "text-[#C5A68F]",
      },
    ],
  },
  {
    title: "Data Management",
    items: [
      {
        title: "Export & Storage",
        description: "Backup and restore your data",
        href: "/settings/data",
        icon: Database,
        iconBg: "bg-primary/10",
        iconColor: "text-primary",
      },
      {
        title: "Trash",
        description: "Recover deleted items",
        href: "/settings/trash",
        icon: Trash2,
        iconBg: "bg-error/10",
        iconColor: "text-error",
      },
    ],
  },
];

export default function SettingsPage() {
  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {/* Header - hidden on mobile, shown on desktop */}
      <div className="hidden md:block space-y-1">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Settings className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Settings</h1>
            <p className="text-sm text-muted-foreground">
              Manage your account and preferences
            </p>
          </div>
        </div>
      </div>

      {/* Settings Sections */}
      <div className="space-y-6">
        {settingsSections.map((section, sectionIndex) => (
          <div key={section.title} className="space-y-3">
            {/* Section Header */}
            <div className="flex items-center gap-2 px-1">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {section.title}
              </h2>
              <div className="flex-1 h-px bg-border/50" />
            </div>

            {/* Section Items */}
            <div className="space-y-2">
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Link key={item.href} href={item.href} className="block group">
                    <div
                      className={cn(
                        "glass-card rounded-xl p-4 transition-all duration-200",
                        "hover:border-primary/30 hover:scale-[1.01]",
                        "cursor-pointer"
                      )}
                    >
                      <div className="flex items-center gap-4">
                        <div
                          className={cn(
                            "flex h-11 w-11 items-center justify-center rounded-xl transition-transform duration-200",
                            "group-hover:scale-105",
                            item.iconBg
                          )}
                        >
                          <Icon className={cn("h-5 w-5", item.iconColor)} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium text-foreground group-hover:text-primary transition-colors">
                            {item.title}
                          </h3>
                          <p className="text-sm text-muted-foreground truncate">
                            {item.description}
                          </p>
                        </div>
                        <ChevronRight className="h-5 w-5 text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
