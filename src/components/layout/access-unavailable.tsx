"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { LogOut, ShieldOff } from "lucide-react";
import { siteConfig } from "@/config/site";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

/**
 * Shown in place of the dashboard when the signed-in account is not on the
 * team or has been suspended. One sentence, one way out.
 */
export function AccessUnavailable({
  state,
  email,
}: {
  state: "not_member" | "suspended";
  email?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  const signOut = async () => {
    setBusy(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="glass-card rounded-2xl p-8 w-full max-w-md text-center space-y-5">
        <Image
          src={siteConfig.logos.horizontalInverted}
          alt={siteConfig.companyName}
          width={3443}
          height={820}
          sizes="160px"
          className="mx-auto h-8 w-auto"
          style={{ width: "auto", height: 32 }}
          priority
        />
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-copper/10">
          <ShieldOff className="h-6 w-6 text-copper" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-foreground">
            {state === "suspended"
              ? "Your access is suspended"
              : "This account is not on the team"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {state === "suspended"
              ? "An owner paused this account. Ask them to reactivate it."
              : `${email ? `${email} is signed in, but ` : ""}only people the owner adds under Team can open this workspace.`}
          </p>
        </div>
        <Button variant="secondary" onClick={signOut} loading={busy} className="w-full">
          <LogOut aria-hidden="true" />
          Sign out
        </Button>
      </div>
    </main>
  );
}
