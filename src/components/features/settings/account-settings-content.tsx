"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Save, Loader2, Mail, Lock, AlertCircle, CheckCircle2, User as UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { User } from "@supabase/supabase-js";

interface AccountSettingsContentProps {
  user: User;
}

export function AccountSettingsContent({ user }: AccountSettingsContentProps) {
  const [isSaving, setIsSaving] = React.useState(false);
  const [message, setMessage] = React.useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Email form
  const [email, setEmail] = React.useState(user.email || "");

  // Password form
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");

  // Auto-clear message after 5 seconds
  React.useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleUpdateEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (email === user.email) return;

    setIsSaving(true);
    setMessage(null);
    const supabase = createClient();

    try {
      const { error } = await supabase.auth.updateUser({ email });
      if (error) throw error;
      setMessage({
        type: "success",
        text: "Check your inbox to confirm the email change.",
      });
    } catch (error: unknown) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to update email",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      setMessage({ type: "error", text: "Passwords do not match" });
      return;
    }

    if (newPassword.length < 8) {
      setMessage({
        type: "error",
        text: "Password must be at least 8 characters",
      });
      return;
    }

    setIsSaving(true);
    setMessage(null);
    const supabase = createClient();

    try {
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (error) throw error;
      setNewPassword("");
      setConfirmPassword("");
      setMessage({ type: "success", text: "Password updated successfully" });
    } catch (error: unknown) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to update password",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <UserIcon className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Account</h1>
            <p className="text-sm text-muted-foreground">
              Manage your email and password
            </p>
          </div>
        </div>
        <Link href="/settings">
          <Button size="sm" className="rounded-xl gap-1">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </Link>
      </div>

      {/* Message Toast */}
      {message && (
        <div
          className={cn(
            "flex items-center gap-3 rounded-xl px-4 py-3 text-sm",
            message.type === "success"
              ? "bg-success/10 text-success border border-success/20"
              : "bg-error/10 text-error border border-error/20"
          )}
        >
          {message.type === "success" ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          {message.text}
        </div>
      )}

      {/* Email Section */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Email Address
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>

        <div className="glass-card rounded-xl p-6">
          <form onSubmit={handleUpdateEmail} className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 shrink-0">
                <Mail className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1 space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground mb-3">
                    Your email address is used for signing in and notifications.
                  </p>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    className="max-w-md"
                    required
                  />
                </div>
                <Button
                  type="submit"
                  disabled={isSaving || email === user.email}
                  size="sm"
                  className="rounded-lg"
                >
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Update Email
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>

      {/* Password Section */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Password
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>

        <div className="glass-card rounded-xl p-6">
          <form onSubmit={handleUpdatePassword} className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#C5A68F]/10 shrink-0">
                <Lock className="h-5 w-5 text-[#C5A68F]" />
              </div>
              <div className="flex-1 space-y-4">
                <p className="text-sm text-muted-foreground">
                  Choose a strong password with at least 8 characters.
                </p>
                <div className="grid gap-3 max-w-md">
                  <Input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="New password"
                    required
                  />
                  <Input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                    required
                  />
                </div>
                <Button
                  type="submit"
                  disabled={isSaving || !newPassword || !confirmPassword}
                  size="sm"
                  className="rounded-lg"
                >
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Update Password
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
