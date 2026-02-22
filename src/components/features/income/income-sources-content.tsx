"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Pencil,
  Trash2,
  Save,
  X,
  Loader2,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import type { IncomeSource } from "@/types/database";

interface IncomeSourcesContentProps {
  sources: IncomeSource[];
}

const DEFAULT_COLORS = [
  "#5B8A8A", // Teal (primary)
  "#6366f1", // Indigo
  "#8b5cf6", // Violet
  "#ec4899", // Pink
  "#f43f5e", // Rose
  "#f97316", // Orange
  "#eab308", // Yellow
  "#22c55e", // Green
];

export function IncomeSourcesContent({ sources }: IncomeSourcesContentProps) {
  const router = useRouter();
  const [isAddOpen, setIsAddOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // Add form state
  const [newName, setNewName] = React.useState("");
  const [newColor, setNewColor] = React.useState(DEFAULT_COLORS[0]);
  const [addError, setAddError] = React.useState<string | null>(null);

  // Edit form state
  const [editName, setEditName] = React.useState("");
  const [editColor, setEditColor] = React.useState("");

  const handleAdd = async () => {
    if (!newName.trim()) return;

    // In demo mode, show message and close dialog
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      setNewName("");
      setNewColor(DEFAULT_COLORS[0]);
      setIsAddOpen(false);
      return;
    }

    setIsSubmitting(true);
    setAddError(null);
    const supabase = createClient();

    try {
      const slug = newName.trim().toLowerCase().replace(/\s+/g, "-");

      // Check if slug already exists
      const { data: existing } = await supabase
        .from("income_sources")
        .select("id")
        .eq("slug", slug)
        .maybeSingle();

      if (existing) {
        setAddError("An income source with this name already exists");
        setIsSubmitting(false);
        return;
      }

      const maxOrder = Math.max(...sources.map((s) => s.sort_order), 0);
      await supabase.from("income_sources").insert({
        name: newName.trim(),
        slug,
        color: newColor,
        sort_order: maxOrder + 1,
      });

      setNewName("");
      setNewColor(DEFAULT_COLORS[0]);
      setAddError(null);
      setIsAddOpen(false);
      router.refresh();
    } catch (error) {
      console.error("Error adding source:", error);
      setAddError("Failed to add income source");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = (source: IncomeSource) => {
    setEditingId(source.id);
    setEditName(source.name);
    setEditColor(source.color || DEFAULT_COLORS[0]);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editName.trim()) return;

    // In demo mode, show message and close edit
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      setEditingId(null);
      return;
    }

    setIsSubmitting(true);
    const supabase = createClient();

    try {
      await supabase
        .from("income_sources")
        .update({ name: editName.trim(), color: editColor })
        .eq("id", editingId);

      setEditingId(null);
      router.refresh();
    } catch (error) {
      console.error("Error updating source:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure? This will soft-delete the source.")) return;

    // In demo mode, show message
    if (isDemoMode()) {
      alert("Demo mode: Changes won't be saved. This is just a preview of the functionality.");
      return;
    }

    const supabase = createClient();

    try {
      await supabase
        .from("income_sources")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      router.refresh();
    } catch (error) {
      console.error("Error deleting source:", error);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {/* Header - hidden on mobile (mobile uses header bar) */}
      <div className="hidden md:flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
          <Layers className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Income Sources</h1>
          <p className="text-sm text-muted-foreground">
            Manage your revenue categories
          </p>
        </div>
      </div>

      {/* Sources List */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {sources.length} Source{sources.length !== 1 && "s"}
          </h2>
          <div className="flex-1 h-px bg-border/50" />
          <Dialog open={isAddOpen} onOpenChange={(open) => {
            setIsAddOpen(open);
            if (!open) setAddError(null);
          }}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1 h-7 text-xs">
                <Plus className="h-3 w-3" />
                Add
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Income Source</DialogTitle>
                <DialogDescription>
                  Create a new category for tracking income.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <Input
                  label="Name"
                  value={newName}
                  onChange={(e) => {
                    setNewName(e.target.value);
                    if (addError) setAddError(null);
                  }}
                  placeholder="e.g., Freelance, Investments"
                />
                <div className="space-y-2">
                  <label className="text-sm font-medium">Color</label>
                  <div className="flex flex-wrap items-center gap-2">
                    {DEFAULT_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setNewColor(color)}
                        className={cn(
                          "h-8 w-8 rounded-full transition-all",
                          newColor === color && "ring-2 ring-primary"
                        )}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                    {/* Custom color picker */}
                    <div className="relative h-8 w-8">
                      <input
                        type="color"
                        value={newColor}
                        onChange={(e) => setNewColor(e.target.value)}
                        className="absolute inset-0 h-8 w-8 cursor-pointer opacity-0"
                      />
                      {!DEFAULT_COLORS.includes(newColor) ? (
                        <div
                          className="h-8 w-8 rounded-full ring-2 ring-primary"
                          style={{ backgroundColor: newColor }}
                        />
                      ) : (
                        <div className="h-8 w-8 rounded-full border-2 border-dashed border-muted-foreground/50 flex items-center justify-center transition-all hover:border-primary">
                          <Plus className="h-3 w-3 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    {/* Hex input for custom color */}
                    {!DEFAULT_COLORS.includes(newColor) && (
                      <Input
                        value={newColor}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (/^#[0-9A-Fa-f]{0,6}$/.test(val)) {
                            setNewColor(val);
                          }
                        }}
                        className="w-24 font-mono text-sm uppercase h-8"
                        maxLength={7}
                      />
                    )}
                  </div>
                </div>
                {addError && (
                  <p className="text-sm text-error">{addError}</p>
                )}
              </div>
              <DialogFooter>
                <Button
                  onClick={handleAdd}
                  disabled={isSubmitting || !newName.trim()}
                >
                  {isSubmitting ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4 mr-1" />
                  )}
                  Add Source
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <div className="glass-card rounded-xl overflow-hidden">
          <div className="divide-y divide-border/50">
            {sources.map((source) => (
              <div
                key={source.id}
                className={cn(
                  "px-4 py-3 transition-colors hover:bg-secondary/30",
                  editingId === source.id ? "flex flex-col gap-3" : "flex items-center gap-4"
                )}
              >
                {editingId === source.id ? (
                  <>
                    {/* Row 1: Same layout as non-edit rows */}
                    <div className="flex items-center gap-4 w-full">
                      <div
                        className="h-4 w-4 rounded-full flex-shrink-0"
                        style={{ backgroundColor: editColor || "#5B8A8A" }}
                      />
                      <span className="flex-1 min-w-0">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="w-full"
                        />
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setEditingId(null)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        onClick={handleSaveEdit}
                        disabled={isSubmitting}
                      >
                        <Save className="h-4 w-4" />
                      </Button>
                    </div>
                    {/* Row 2: Color options */}
                    <div className="flex flex-wrap items-center gap-2 pl-8">
                      {DEFAULT_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          onClick={() => setEditColor(color)}
                          className={cn(
                            "h-7 w-7 rounded-full transition-all",
                            editColor === color && "ring-2 ring-primary"
                          )}
                          style={{ backgroundColor: color }}
                        />
                      ))}
                      {/* Custom color picker */}
                      <div className="relative h-7 w-7">
                        <input
                          type="color"
                          value={editColor}
                          onChange={(e) => setEditColor(e.target.value)}
                          className="absolute inset-0 h-7 w-7 cursor-pointer opacity-0"
                        />
                        {!DEFAULT_COLORS.includes(editColor) ? (
                          <div
                            className="h-7 w-7 rounded-full ring-2 ring-primary"
                            style={{ backgroundColor: editColor }}
                          />
                        ) : (
                          <div className="h-7 w-7 rounded-full border-2 border-dashed border-muted-foreground/50 flex items-center justify-center transition-all hover:border-primary">
                            <Plus className="h-3 w-3 text-muted-foreground" />
                          </div>
                        )}
                      </div>
                      {/* Hex input for custom color */}
                      {!DEFAULT_COLORS.includes(editColor) && (
                        <Input
                          value={editColor}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (/^#[0-9A-Fa-f]{0,6}$/.test(val)) {
                              setEditColor(val);
                            }
                          }}
                          className="w-24 font-mono text-sm uppercase h-7"
                          maxLength={7}
                        />
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      className="h-4 w-4 rounded-full flex-shrink-0"
                      style={{ backgroundColor: source.color || "#5B8A8A" }}
                    />
                    <span className="flex-1 font-medium">{source.name}</span>
                    <Tooltip content="Edit source">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleEdit(source)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    </Tooltip>
                    <Tooltip content="Delete source">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-error hover:text-error"
                      onClick={() => handleDelete(source.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    </Tooltip>
                  </>
                )}
              </div>
            ))}

            {sources.length === 0 && (
              <div className="py-12 text-center text-muted-foreground">
                No income sources found. Add one to get started.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
