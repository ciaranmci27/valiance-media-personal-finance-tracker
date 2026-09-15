"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { PasswordInput } from "@/components/ui/inputs/PasswordInput";
import { Select } from "@/components/ui/inputs/Select";
import { generatePassword, inviteMember, TeamRequestError } from "@/lib/team";
import { ROLE_LABELS, TEAM_ROLES, type TeamMember, type TeamRole } from "@/lib/access-control";

interface AddMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Owners may add admins and owners; everyone else adds members. */
  canAssignRoles: boolean;
  onAdded: (member: TeamMember) => void;
}

export function AddMemberDialog({ open, onOpenChange, canAssignRoles, onAdded }: AddMemberDialogProps) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [role, setRole] = React.useState<TeamRole>("member");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  const reset = () => {
    setName("");
    setEmail("");
    setPassword("");
    setRole("member");
    setErrors({});
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const validate = () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Name is required";
    if (!email.trim()) next.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = "Enter a valid email address";
    if (!password) next.password = "A password is required";
    else if (password.length < 8) next.password = "At least 8 characters";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      const saved = await inviteMember({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
        role,
      });
      onAdded(saved);
      close(false);
    } catch (error) {
      if (error instanceof TeamRequestError) {
        if (Object.keys(error.fields).length) setErrors(error.fields);
        else if (error.status === 409) setErrors({ email: error.message });
        else setErrors({ form: error.message });
      } else {
        setErrors({ form: error instanceof Error ? error.message : "Nothing was saved." });
      }
    } finally {
      setSaving(false);
    }
  };

  const roleOptions = (canAssignRoles ? TEAM_ROLES : (["member"] as const)).map((value) => ({
    value,
    label: ROLE_LABELS[value],
  }));

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Add member</DialogTitle>
            <DialogDescription className="sr-only">
              Create a sign-in for a new team member and choose their role.
            </DialogDescription>
          </DialogHeader>

          {errors.form && (
            <p role="alert" className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error">
              {errors.form}
            </p>
          )}

          <div className="space-y-4">
            <TextInput
              label="Name"
              value={name}
              onChange={setName}
              placeholder="Full name"
              error={errors.name}
              autoFocus
              required
            />
            <TextInput
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="name@company.com"
              error={errors.email}
              autoComplete="off"
              required
            />
            <div className="space-y-1.5">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
                <PasswordInput
                  label="Temporary password"
                  value={password}
                  onChange={setPassword}
                  error={errors.password}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setPassword(generatePassword());
                    setErrors((current) => ({ ...current, password: "" }));
                  }}
                  className="sm:mt-[26px]"
                >
                  <Sparkles aria-hidden="true" />
                  Generate
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Share it with them out of band; they can change it under Settings, Account.
              </p>
            </div>
            <Select
              label="Role"
              value={role}
              onChange={(value) => setRole(value as TeamRole)}
              options={roleOptions}
              disabled={!canAssignRoles}
              helperText={
                canAssignRoles
                  ? "Admins get every default; members start read-only."
                  : "Members start read-only. An owner can change roles."
              }
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              Add member
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
