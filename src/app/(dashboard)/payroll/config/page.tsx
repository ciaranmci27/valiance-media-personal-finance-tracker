import Link from "next/link";
import {
  Building2,
  Landmark,
  Map as MapIcon,
  ChevronRight,
  Settings2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const metadata = {
  title: "Payroll Settings",
};

const configSections = [
  {
    title: "Organization",
    items: [
      {
        title: "Organization",
        description: "Legal name, EIN, state IDs, address, signer",
        href: "/payroll/config/organization",
        icon: Building2,
        iconBg: "bg-primary/10",
        iconColor: "text-primary",
      },
    ],
  },
  {
    title: "Tax Tables",
    items: [
      {
        title: "Federal",
        description: "Brackets, FICA, FUTA, standard deductions",
        href: "/payroll/config/federal",
        icon: Landmark,
        iconBg: "bg-[#C5A68F]/10",
        iconColor: "text-[#C5A68F]",
      },
      {
        title: "States",
        description: "State income tax, SDI, SUTA configuration",
        href: "/payroll/config/states",
        icon: MapIcon,
        iconBg: "bg-violet-500/10",
        iconColor: "text-violet-500",
      },
    ],
  },
];

export default function PayrollConfigPage() {
  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div className="hidden md:block space-y-1">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Settings2 className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Payroll Settings</h1>
            <p className="text-sm text-muted-foreground">
              Configure organization info and tax tables
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        {configSections.map((section) => (
          <div key={section.title} className="space-y-3">
            <div className="flex items-center gap-2 px-1">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {section.title}
              </h2>
              <div className="flex-1 h-px bg-border/50" />
            </div>

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
                          <Icon className={cn("h-5 w-5", item.iconColor)} aria-hidden="true" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium text-foreground group-hover:text-primary transition-colors">
                            {item.title}
                          </h3>
                          <p className="text-sm text-muted-foreground truncate">
                            {item.description}
                          </p>
                        </div>
                        <ChevronRight className="h-5 w-5 text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all" aria-hidden="true" />
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
