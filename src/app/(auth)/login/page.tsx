"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { siteConfig } from "@/config/site";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Mail, Lock, AlertCircle, Eye, EyeOff } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [theme, setTheme] = React.useState<"light" | "dark" | null>(null);

  // Read theme from DOM on mount
  React.useEffect(() => {
    const currentTheme = document.documentElement.getAttribute("data-theme") as "light" | "dark" | null;
    setTheme(currentTheme === "light" ? "light" : "dark");
  }, []);

  const displayTheme = theme ?? "dark";

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setError(error.message);
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md animate-fade-up">
      <Card className="overflow-hidden">
        <CardHeader className="space-y-4 text-center pb-8">
          {/* Logo - switches based on theme */}
          <div className="flex justify-center">
            <Image
              src={displayTheme === "dark" ? siteConfig.logos.horizontalInverted : siteConfig.logos.horizontal}
              alt={siteConfig.companyName}
              width={180}
              height={40}
              className="h-10 w-auto"
              priority
            />
          </div>
          <div className="space-y-2">
            <CardTitle className="text-2xl font-bold">Welcome back</CardTitle>
            <CardDescription>
              Sign in to access your admin dashboard
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-error/50 bg-error/10 p-3 text-sm text-error animate-fade-in">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium text-foreground">
                Email
              </label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                icon={<Mail className="h-4 w-4" />}
                required
                autoComplete="email"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium text-foreground">
                Password
              </label>
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                icon={<Lock className="h-4 w-4" />}
                rightIcon={
                  showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )
                }
                onRightIconClick={() => setShowPassword(!showPassword)}
                required
                autoComplete="current-password"
              />
            </div>

            <Button
              type="submit"
              className="w-full my-2"
              size="lg"
              loading={loading}
            >
              Sign In
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
