"use client";

import * as React from "react";
import { Plus, ShieldCheck, Pencil, KeyRound, UserMinus, UserCheck, Users } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { RowActionsMenu, type RowAction } from "@/components/ui/row-actions-menu";
import { toast } from "@/components/ui/toast";
import { useAccess } from "@/contexts/access-context";
import { loadTeam, sortMembers, updateMember } from "@/lib/team";
import {
  initialsOf,
  ROLE_LABELS,
  ROLE_ORDER,
  type TeamMember,
  type TeamRole,
} from "@/lib/access-control";
import { cn } from "@/lib/utils";
import { AddMemberDialog } from "./add-member-dialog";
import { EditMemberDialog } from "./edit-member-dialog";
import { AccessDialog } from "./access-dialog";

const ROLE_BADGE: Record<TeamRole, BadgeVariant> = {
  owner: "copper",
  admin: "info",
  member: "default",
};

function MemberIdentity({ member, isSelf }: { member: TeamMember; isSelf: boolean }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          member.status === "active"
            ? "bg-primary/15 text-teal-light"
            : "bg-[rgba(var(--ink),0.06)] text-muted-foreground",
        )}
        aria-hidden="true"
      >
        {initialsOf(member.name) || "?"}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-foreground truncate">{member.name}</span>
          {isSelf && (
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">you</span>
          )}
        </div>
        {member.title && (
          <div className="text-xs text-muted-foreground truncate">{member.title}</div>
        )}
      </div>
    </div>
  );
}

export function TeamContent() {
  const { member: me, role, hasPermission } = useAccess();
  const isOwner = role === "owner";
  const canManage = hasPermission("team.manage");

  const [members, setMembers] = React.useState<TeamMember[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TeamMember | null>(null);
  const [accessOpen, setAccessOpen] = React.useState(false);
  const [accessMemberId, setAccessMemberId] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setMembers(await loadTeam());
    } catch (error) {
      toast("error", error instanceof Error ? error.message : "The team could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const upsert = (saved: TeamMember) =>
    setMembers((current) =>
      sortMembers([...current.filter((m) => m.id !== saved.id), saved]),
    );

  const setStatus = async (target: TeamMember, status: TeamMember["status"]) => {
    setPending(target.id);
    try {
      upsert(await updateMember(target.id, { status }));
      toast(
        "success",
        status === "suspended"
          ? `${target.name} is suspended.`
          : `${target.name} is active again.`,
      );
    } catch (error) {
      toast("error", error instanceof Error ? error.message : "Nothing was saved.");
    } finally {
      setPending(null);
    }
  };

  const actionsFor = (target: TeamMember): RowAction[] => {
    const isSelf = target.id === me.id;
    const canEditRow = isSelf || (canManage && (isOwner || target.role !== "owner"));
    const actions: RowAction[] = [];
    if (canEditRow)
      actions.push({
        label: "Edit",
        icon: <Pencil size={14} aria-hidden="true" />,
        onSelect: () => setEditing(target),
      });
    if (isOwner && target.role !== "owner")
      actions.push({
        label: "Permissions",
        icon: <KeyRound size={14} aria-hidden="true" />,
        onSelect: () => {
          setAccessMemberId(target.id);
          setAccessOpen(true);
        },
      });
    if (canManage && !isSelf && (isOwner || target.role !== "owner")) {
      const suspended = target.status === "suspended";
      actions.push({
        label: suspended ? "Reactivate" : "Suspend",
        icon: suspended ? (
          <UserCheck size={14} aria-hidden="true" />
        ) : (
          <UserMinus size={14} aria-hidden="true" />
        ),
        variant: suspended ? "default" : "danger",
        separator: actions.length > 0,
        disabled: pending === target.id,
        onSelect: () => void setStatus(target, suspended ? "active" : "suspended"),
      });
    }
    return actions;
  };

  const columns: DataTableColumn<TeamMember>[] = [
    {
      key: "name",
      header: "Name",
      render: (row) => <MemberIdentity member={row} isSelf={row.id === me.id} />,
      sortValue: (row) => row.name.toLowerCase(),
    },
    {
      key: "email",
      header: "Email",
      render: (row) => <span className="text-muted-foreground">{row.email}</span>,
      sortValue: (row) => row.email,
      className: "hidden md:table-cell",
    },
    {
      key: "role",
      header: "Role",
      render: (row) => <Badge variant={ROLE_BADGE[row.role]}>{ROLE_LABELS[row.role]}</Badge>,
      sortValue: (row) => ROLE_ORDER[row.role],
      width: "120px",
    },
    {
      key: "status",
      header: "Status",
      render: (row) =>
        row.status === "active" ? (
          <Badge variant="success" dot>Active</Badge>
        ) : (
          <Badge variant="warning" dot>Suspended</Badge>
        ),
      sortValue: (row) => row.status,
      width: "130px",
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: "56px",
      render: (row) => {
        const actions = actionsFor(row);
        return actions.length ? (
          <RowActionsMenu actions={actions} label={`Actions for ${row.name}`} />
        ) : null;
      },
    },
  ];

  const mobileCard = (row: TeamMember) => {
    const actions = actionsFor(row);
    return (
      <div className="glass-card rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <MemberIdentity member={row} isSelf={row.id === me.id} />
          {actions.length > 0 && (
            <RowActionsMenu actions={actions} label={`Actions for ${row.name}`} />
          )}
        </div>
        <div className="text-sm text-muted-foreground break-all">{row.email}</div>
        <div className="flex items-center gap-2">
          <Badge variant={ROLE_BADGE[row.role]}>{ROLE_LABELS[row.role]}</Badge>
          {row.status === "active" ? (
            <Badge variant="success" dot>Active</Badge>
          ) : (
            <Badge variant="warning" dot>Suspended</Badge>
          )}
        </div>
      </div>
    );
  };

  const count = members.length;

  return (
    <div className="space-y-5 lg:space-y-6">
      <PageHeader
        title="Team"
        subtitle={loading ? "Loading the team" : `${count} ${count === 1 ? "member" : "members"}`}
        actions={
          <>
            {isOwner && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setAccessMemberId(null);
                  setAccessOpen(true);
                }}
              >
                <ShieldCheck aria-hidden="true" />
                <span className="hidden sm:inline">Roles &amp; permissions</span>
                <span className="sm:hidden">Roles</span>
              </Button>
            )}
            {canManage && (
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus aria-hidden="true" />
                Add member
              </Button>
            )}
          </>
        }
      />

      <DataTable
        columns={columns}
        data={members}
        keyExtractor={(row) => row.id}
        mobileCard={mobileCard}
        busy={loading}
        skeletonRows={3}
        initialSort={{ key: "role", dir: "asc" }}
        emptyState={
          <div className="py-12 text-center space-y-2">
            <Users className="mx-auto h-8 w-8 text-muted-foreground/60" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Only you so far.</p>
          </div>
        }
      />

      <AddMemberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        canAssignRoles={isOwner}
        onAdded={(saved) => {
          upsert(saved);
          toast("success", `${saved.name} was added to the team.`);
        }}
      />
      <EditMemberDialog
        member={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={(saved) => {
          upsert(saved);
          toast("success", "Saved.");
        }}
      />
      {isOwner && (
        <AccessDialog
          open={accessOpen}
          onOpenChange={setAccessOpen}
          team={members}
          initialMemberId={accessMemberId}
        />
      )}
    </div>
  );
}
