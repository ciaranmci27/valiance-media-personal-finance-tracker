"use client";

import * as React from "react";
import { Check, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/inputs/Select";
import { toast } from "@/components/ui/toast";
import { useAccess } from "@/contexts/access-context";
import { loadAccessPolicy, setMemberOverride, setRoleDefault, type AccessPolicy } from "@/lib/team";
import {
  EDITABLE_ROLES,
  PERMISSION_GROUPS,
  ROLE_LABELS,
  type PermissionEffect,
  type PermissionKey,
  type TeamMember,
  type TeamRole,
} from "@/lib/access-control";
import { cn } from "@/lib/utils";

// Presentational box on each row; the whole row is the button.
const BOX = "flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors";
const boxCheck = (
  <span className={cn(BOX, "border-primary bg-primary text-primary-foreground")}>
    <Check size={11} strokeWidth={3} aria-hidden="true" />
  </span>
);
const boxDeny = (
  <span className={cn(BOX, "border-error bg-error text-white")}>
    <X size={11} strokeWidth={3} aria-hidden="true" />
  </span>
);
const boxEmpty = <span className={cn(BOX, "border-border bg-transparent")} />;
const boxInherit = (on: boolean) => (
  <span className={cn(BOX, "border-dashed border-border bg-transparent text-muted-foreground")}>
    {on ? <Check size={11} strokeWidth={3} aria-hidden="true" /> : null}
  </span>
);

interface AccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: TeamMember[];
  /** Opens on this person's exceptions instead of the role defaults. */
  initialMemberId?: string | null;
}

export function AccessDialog({ open, onOpenChange, team, initialMemberId = null }: AccessDialogProps) {
  const { member: me } = useAccess();
  const [policy, setPolicy] = React.useState<AccessPolicy>({ role_permissions: [], member_permissions: [] });
  const [target, setTarget] = React.useState<"role" | "member">("role");
  const [role, setRole] = React.useState<TeamRole>("member");
  const [memberId, setMemberId] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  const members = React.useMemo(() => team.filter((m) => m.role !== "owner"), [team]);
  const selectedMember = members.find((m) => m.id === memberId);

  React.useEffect(() => {
    if (!open) return;
    if (initialMemberId && members.some((m) => m.id === initialMemberId)) {
      setTarget("member");
      setMemberId(initialMemberId);
    } else {
      setTarget("role");
      setMemberId((current) => (members.some((m) => m.id === current) ? current : members[0]?.id ?? ""));
    }
    setLoading(true);
    loadAccessPolicy()
      .then(setPolicy)
      .catch((error) => toast("error", error instanceof Error ? error.message : "Permissions could not be loaded."))
      .finally(() => setLoading(false));
  }, [open, initialMemberId, members]);

  const roleHas = (key: PermissionKey, forRole: TeamRole = role) =>
    policy.role_permissions.some((row) => row.role === forRole && row.permission_key === key);
  const override = (key: PermissionKey): PermissionEffect | null =>
    policy.member_permissions.find((row) => row.member_id === memberId && row.permission_key === key)?.effect ?? null;

  // Functional updates so quick clicks on different rows never clobber each other.
  const applyRole = (current: AccessPolicy, key: PermissionKey, on: boolean): AccessPolicy => ({
    ...current,
    role_permissions: [
      ...current.role_permissions.filter((row) => !(row.role === role && row.permission_key === key)),
      ...(on ? [{ role: role as "admin" | "member", permission_key: key, created_at: new Date().toISOString() }] : []),
    ],
  });
  const applyMember = (current: AccessPolicy, key: PermissionKey, effect: PermissionEffect | null): AccessPolicy => ({
    ...current,
    member_permissions: [
      ...current.member_permissions.filter((row) => !(row.member_id === memberId && row.permission_key === key)),
      ...(effect
        ? [{ member_id: memberId, permission_key: key, effect, created_by: me.id, created_at: new Date().toISOString() }]
        : []),
    ],
  });

  const toggleRole = async (key: PermissionKey) => {
    const prior = roleHas(key);
    setPolicy((current) => applyRole(current, key, !prior));
    try {
      await setRoleDefault(role, key, !prior);
    } catch (error) {
      setPolicy((current) => applyRole(current, key, prior));
      toast("error", error instanceof Error ? error.message : "The default could not be saved.");
    }
  };

  const cycleMember = async (key: PermissionKey) => {
    if (!memberId) return;
    const prior = override(key);
    const next: PermissionEffect | null = prior === null ? "allow" : prior === "allow" ? "deny" : null;
    setPolicy((current) => applyMember(current, key, next));
    try {
      await setMemberOverride(memberId, key, next, me.id);
    } catch (error) {
      setPolicy((current) => applyMember(current, key, prior));
      toast("error", error instanceof Error ? error.message : "The exception could not be saved.");
    }
  };

  const segment = (value: "role" | "member", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={target === value}
      onClick={() => setTarget(value)}
      className={cn(
        "flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        target === value
          ? "bg-[rgba(var(--ink),0.09)] text-foreground shadow-[inset_0_1px_0_rgba(var(--ink),0.16)]"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Roles &amp; permissions</DialogTitle>
          <DialogDescription className="sr-only">
            Set what each role may do by default and add exceptions for one person.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-5">
          <div
            role="tablist"
            aria-label="Edit defaults or exceptions"
            className="flex items-center gap-0.5 rounded-lg bg-[rgba(var(--ink),0.05)] p-0.5 shadow-[inset_0_0_0_1px_rgba(var(--ink),0.06)]"
          >
            {segment("role", "Role defaults")}
            {segment("member", "Individual access")}
          </div>

          {target === "role" ? (
            <Select
              label="Role"
              value={role}
              onChange={(value) => setRole(value as TeamRole)}
              options={EDITABLE_ROLES.map((value) => ({ value, label: ROLE_LABELS[value] }))}
              helperText="Owners always have everything."
            />
          ) : members.length ? (
            <Select
              label="Team member"
              value={memberId}
              onChange={setMemberId}
              options={members.map((m) => ({
                value: m.id,
                label: m.name,
                detail: ROLE_LABELS[m.role],
              }))}
              helperText={`A dashed box follows the ${selectedMember ? ROLE_LABELS[selectedMember.role].toLowerCase() : "role"} default. Click a row to cycle Inherit, Allow, Deny.`}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Add a member first to set exceptions.</p>
          )}

          {loading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading permissions</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {PERMISSION_GROUPS.map((group) => (
                <div key={group.id} className="overflow-hidden rounded-xl border border-border">
                  <div className="border-b border-border bg-[rgba(var(--ink),0.03)] px-4 py-2.5">
                    <h3 className="text-sm font-semibold text-foreground">{group.label}</h3>
                  </div>
                  <div className="divide-y divide-border">
                    {group.permissions.map((permission) => {
                      const isMember = target === "member";
                      const current = override(permission.key);
                      const inherited = selectedMember ? roleHas(permission.key, selectedMember.role) : false;
                      const on = roleHas(permission.key);
                      const state = isMember
                        ? current === "allow"
                          ? "Allowed"
                          : current === "deny"
                            ? "Denied"
                            : `Inherits the role default (${inherited ? "on" : "off"})`
                        : on
                          ? "On"
                          : "Off";
                      return (
                        <button
                          type="button"
                          key={permission.key}
                          disabled={isMember && !memberId}
                          onClick={() => (isMember ? void cycleMember(permission.key) : void toggleRole(permission.key))}
                          aria-label={`${permission.label}: ${state}. ${isMember ? "Click to cycle Inherit, Allow, Deny." : "Click to toggle."}`}
                          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[rgba(var(--ink),0.03)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-50"
                        >
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-foreground">{permission.label}</span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">{permission.description}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {isMember && (
                              <span
                                className={cn(
                                  "text-[11px] font-medium tabular-nums",
                                  current === "allow"
                                    ? "text-teal-light"
                                    : current === "deny"
                                      ? "text-error"
                                      : "text-muted-foreground",
                                )}
                              >
                                {current === "allow" ? "Allow" : current === "deny" ? "Deny" : `Inherit (${inherited ? "on" : "off"})`}
                              </span>
                            )}
                            {isMember
                              ? current === "allow"
                                ? boxCheck
                                : current === "deny"
                                  ? boxDeny
                                  : boxInherit(inherited)
                              : on
                                ? boxCheck
                                : boxEmpty}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
