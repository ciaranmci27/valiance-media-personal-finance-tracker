import Link from "next/link";
import { Lock, ArrowLeft } from "lucide-react";
import { MobileMenuButton, HeaderControls } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";

/**
 * What a member sees on a screen their permissions do not cover. RLS already
 * returns nothing; this says why instead of showing an empty table.
 */
export function AccessDenied({ area }: { area: string }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <MobileMenuButton />
        <h1 className="text-2xl lg:text-[26px] font-bold text-white tracking-tight leading-tight">
          {area}
        </h1>
        <HeaderControls className="ml-auto" />
      </div>
      <div className="glass-card rounded-2xl p-8 max-w-md mx-auto text-center space-y-4">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-copper/10">
          <Lock className="h-5 w-5 text-copper" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <h2 className="font-semibold text-foreground">
            You do not have access to {area}
          </h2>
          <p className="text-sm text-muted-foreground">
            An owner can grant it under Team, Roles and permissions.
          </p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link href="/">
            <ArrowLeft aria-hidden="true" />
            Back to dashboard
          </Link>
        </Button>
      </div>
    </div>
  );
}
