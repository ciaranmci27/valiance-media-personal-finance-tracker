"use client";

import * as React from "react";
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
import { Select } from "@/components/ui/inputs/Select";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { useAccess } from "@/contexts/access-context";
import { changeMemberEmail, updateMember, type MemberPatch } from "@/lib/team";
import { ROLE_LABELS, TEAM_ROLES, type TeamMember, type TeamRole } from "@/lib/access-control";

interface EditMemberDialogProps {
  /** The row being edited; null keeps the dialog closed. */
  member: TeamMember | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (member: TeamMember) => void;
}

export function EditMemberDialog({ member, onOpenChange, onSaved }: EditMemberDialogProps) {
  const { member: me, role: myRole, updateMe } = useAccess();
  const { confirm, dialog: confirmDialog } = useConfirmationDialog();
  const [name, setName] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<TeamRole>("member");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!member) return;
    setName(member.name);
    setTitle(member.title ?? "");
    setEmail(member.email);
    setRole(member.role);
    setError(null);
  }, [member]);

  const isSelf = member?.id === me.id;
  const isOwner = myRole === "owner";
  const canChangeEmail = isOwner || isSelf;
  const canChangeRole = isOwner && !isSelf;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!member) return;
    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let saved = member;
      if (trimmedEmail !== member.email) {
        const ok = await confirm({
          title: "Change sign-in email?",
          description: `${member.name} will sign in with ${trimmedEmail} from now on.`,
          confirmLabel: "Change email",
          variant: "warning",
        });
        if (!ok) {
          setSaving(false);
          return;
        }
        saved = await changeMemberEmail(member.id, trimmedEmail);
      }
      const patch: MemberPatch = {};
      if (trimmedName !== member.name) patch.name = trimmedName;
      if ((title.trim() || null) !== member.title) patch.title = title.trim() || null;
      if (canChangeRole && role !== member.role) patch.role = role;
      if (Object.keys(patch).length) {
        saved = isSelf
          ? { ...saved, ...(await updateMe({ name: patch.name, title: patch.title })) }
          : await updateMember(member.id, patch);
      }
      onSaved(saved);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nothing was saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open={member !== null} onOpenChange={onOpenChange}>
        <DialogContent>
          <form onSubmit={submit} className="space-y-5">
            <DialogHeader>
              <DialogTitle>Edit member</DialogTitle>
              <DialogDescription className="sr-only">
                Change this member&apos;s name, title, email or role.
              </DialogDescription>
            </DialogHeader>

            {error && (
              <p role="alert" className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error">
                {error}
              </p>
            )}

            <div className="space-y-4">
              <TextInput label="Name" value={name} onChange={setName} required autoFocus />
              <TextInput
                label="Title"
                value={title}
                onChange={setTitle}
                placeholder="Bookkeeper, Accountant, Partner"
              />
              <TextInput
                label="Email"
                type="email"
                value={email}
                onChange={setEmail}
                disabled={!canChangeEmail}
                description={canChangeEmail ? undefined : "Only an owner can change someone else's email."}
                required
              />
              {canChangeRole && (
                <Select
                  label="Role"
                  value={role}
                  onChange={(value) => setRole(value as TeamRole)}
                  options={TEAM_ROLES.map((value) => ({ value, label: ROLE_LABELS[value] }))}
                  helperText="Owners have every permission; the workspace always keeps at least one."
                />
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}
