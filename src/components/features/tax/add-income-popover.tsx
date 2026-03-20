"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Plus, FileText, Link2, Pencil, Check, ChevronLeft, Briefcase, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  createTemplateIncomeSources,
  createPersonalTemplateSources,
  isTemplateAlreadyAdded,
} from "@/lib/tax/templates";
import { TAX_CLASSIFICATION_LABELS } from "./tax-setup-card";
import type {
  TaxIncomeSource,
  TaxClassification,
  BusinessType,
  IncomeType,
} from "@/types/database";
import type { FilingStatus } from "@/lib/tax/constants";

// ============================================================================
// Types
// ============================================================================

interface AddIncomePopoverProps {
  taxClassification: TaxClassification | null;
  businessType: BusinessType | null;
  filingStatus: FilingStatus | null;
  onAddTemplates: (sources: TaxIncomeSource[]) => void;
  onAddCustom: () => void;
  onOpenImport: () => void;
  existingSources: TaxIncomeSource[];
}

interface PopoverPosition {
  top: number;
  left: number;
}

type PopoverView = "menu" | "templates";

// ============================================================================
// Constants
// ============================================================================

const BADGE_STYLES: Record<IncomeType, string> = {
  "1099": "bg-primary/15 text-primary border-primary/25",
  w2: "bg-muted text-muted-foreground border-border",
  k1: "bg-copper/15 text-copper border-copper/25",
};

const BADGE_LABELS: Record<IncomeType, string> = {
  "1099": "1099",
  w2: "W-2",
  k1: "K-1",
};

// ============================================================================
// Template Checkbox Row
// ============================================================================

function TemplateRow({
  template,
  alreadyAdded,
  selected,
  onToggle,
}: {
  template: TaxIncomeSource;
  alreadyAdded: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      disabled={alreadyAdded}
      onClick={onToggle}
      className={cn(
        "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors",
        alreadyAdded
          ? "opacity-40 cursor-default"
          : selected
            ? "bg-primary/10"
            : "hover:bg-secondary cursor-pointer"
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
          alreadyAdded
            ? "border-border bg-muted"
            : selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border"
        )}
      >
        {(alreadyAdded || selected) && <Check className="h-2.5 w-2.5" />}
      </span>
      <span className="flex-1 text-sm text-foreground truncate">
        {template.name}
      </span>
      {alreadyAdded ? (
        <span className="text-[10px] text-muted-foreground/60 font-medium">
          Added
        </span>
      ) : template.income_type ? (
        <span
          className={cn(
            "px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded border",
            BADGE_STYLES[template.income_type]
          )}
        >
          {BADGE_LABELS[template.income_type]}
        </span>
      ) : null}
    </button>
  );
}

// ============================================================================
// Component
// ============================================================================

export function AddIncomePopover({
  taxClassification,
  businessType,
  filingStatus,
  onAddTemplates,
  onAddCustom,
  onOpenImport,
  existingSources,
}: AddIncomePopoverProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [view, setView] = React.useState<PopoverView>("menu");
  const [position, setPosition] = React.useState<PopoverPosition | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);

  // Generate business templates for current classification (skip for "no business")
  const businessTemplates = React.useMemo(() => {
    if (!businessType || businessType === "none") return [];
    return createTemplateIncomeSources(businessType, taxClassification);
  }, [businessType, taxClassification]);

  // Personal templates (tailored to filing status)
  const personalTemplates = React.useMemo(
    () => createPersonalTemplateSources(filingStatus),
    [filingStatus]
  );

  // Determine which templates are already added
  const businessStates = React.useMemo(() => {
    return businessTemplates.map((t) => ({
      template: t,
      alreadyAdded: isTemplateAlreadyAdded(t, existingSources),
    }));
  }, [businessTemplates, existingSources]);

  const personalStates = React.useMemo(() => {
    return personalTemplates.map((t) => ({
      template: t,
      alreadyAdded: isTemplateAlreadyAdded(t, existingSources),
    }));
  }, [personalTemplates, existingSources]);

  const allTemplates = [...businessStates, ...personalStates];

  // Reset state when popover opens
  React.useEffect(() => {
    if (isOpen) {
      setView("menu");
      setSelectedIds(new Set());
    }
  }, [isOpen]);

  // Position calculation
  const updatePosition = React.useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const popoverWidth = 300;
      let left = rect.right + window.scrollX - popoverWidth;
      if (left < 8) {
        left = rect.left + window.scrollX;
      }
      setPosition({
        top: rect.bottom + window.scrollY + 6,
        left,
      });
    }
  }, []);

  React.useLayoutEffect(() => {
    if (isOpen) updatePosition();
  }, [isOpen, updatePosition]);

  React.useEffect(() => {
    if (!isOpen) return;
    const handler = () => updatePosition();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [isOpen, updatePosition]);

  React.useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  React.useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (view === "templates") {
          setView("menu");
        } else {
          setIsOpen(false);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, view]);

  // Handlers
  const toggleTemplate = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAddTemplates = () => {
    const toAdd = allTemplates
      .filter((t) => selectedIds.has(t.template.id) && !t.alreadyAdded)
      .map((t) => ({
        ...t.template,
        id: crypto.randomUUID(),
      }));
    if (toAdd.length > 0) {
      onAddTemplates(toAdd);
    }
    setIsOpen(false);
  };

  const selectedCount = [...selectedIds].filter(
    (id) => !allTemplates.find((t) => t.template.id === id)?.alreadyAdded
  ).length;

  const classificationLabel = taxClassification
    ? TAX_CLASSIFICATION_LABELS[taxClassification]
    : null;

  const allBusinessAdded = businessStates.length > 0 && businessStates.every((t) => t.alreadyAdded);
  const allPersonalAdded = personalStates.every((t) => t.alreadyAdded);

  // Render
  const renderPopover = () => {
    if (!isOpen || !position) return null;

    const popover = (
      <div
        ref={popoverRef}
        style={{
          position: "absolute",
          top: position.top,
          left: position.left,
          width: 300,
          zIndex: 99999,
        }}
        className="bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
      >
        {view === "menu" ? (
          <>
            {/* From templates */}
            <button
              type="button"
              onClick={() => setView("templates")}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-secondary transition-colors cursor-pointer"
            >
              <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0 leading-tight">
                <span className="text-xs font-semibold text-foreground block">
                  From templates
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Business and personal presets
                </span>
              </div>
              <span className="text-muted-foreground/40 text-xs">&rsaquo;</span>
            </button>

            {/* Link tracked income */}
            <div className="border-t border-border/50">
              <button
                type="button"
                onClick={() => { setIsOpen(false); onOpenImport(); }}
                className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-secondary transition-colors cursor-pointer"
              >
                <Link2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0 leading-tight">
                  <span className="text-xs font-semibold text-foreground block">
                    Link tracked income
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    Import from revenue tracker
                  </span>
                </div>
                <span className="text-muted-foreground/40 text-xs">&rsaquo;</span>
              </button>
            </div>

            {/* Custom entry */}
            <div className="border-t border-border/50">
              <button
                type="button"
                onClick={() => { setIsOpen(false); onAddCustom(); }}
                className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-secondary transition-colors cursor-pointer"
              >
                <Pencil className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0 leading-tight">
                  <span className="text-xs font-semibold text-foreground block">
                    Custom entry
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    Add a blank row
                  </span>
                </div>
                <span className="text-muted-foreground/40 text-xs">&rsaquo;</span>
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Back header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
              <button
                type="button"
                onClick={() => setView("menu")}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="text-xs font-semibold text-foreground">
                Templates
              </span>
            </div>

            <div className="p-3 space-y-4 max-h-[360px] overflow-y-auto">
              {/* Business templates */}
              {businessStates.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Briefcase className="h-3 w-3 text-muted-foreground" />
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Business
                    </span>
                    {classificationLabel && (
                      <span className="text-[11px] text-muted-foreground/60">
                        {classificationLabel}
                      </span>
                    )}
                  </div>
                  {allBusinessAdded ? (
                    <p className="text-xs text-muted-foreground/50 italic pl-5">
                      All added
                    </p>
                  ) : (
                    <div className="space-y-0.5">
                      {businessStates.map(({ template, alreadyAdded }) => (
                        <TemplateRow
                          key={template.id}
                          template={template}
                          alreadyAdded={alreadyAdded}
                          selected={selectedIds.has(template.id)}
                          onToggle={() => toggleTemplate(template.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Personal templates */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <User className="h-3 w-3 text-muted-foreground" />
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Personal
                  </span>
                </div>
                {allPersonalAdded ? (
                  <p className="text-xs text-muted-foreground/50 italic pl-5">
                    All added
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {personalStates.map(({ template, alreadyAdded }) => (
                      <TemplateRow
                        key={template.id}
                        template={template}
                        alreadyAdded={alreadyAdded}
                        selected={selectedIds.has(template.id)}
                        onToggle={() => toggleTemplate(template.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Add button */}
            {selectedCount > 0 && (
              <div className="px-3 pb-3">
                <button
                  type="button"
                  onClick={handleAddTemplates}
                  className="w-full py-1.5 text-xs font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  Add {selectedCount} template{selectedCount !== 1 ? "s" : ""}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    );

    if (typeof document !== "undefined") {
      return createPortal(popover, document.body);
    }
    return null;
  };

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        className="h-7 gap-1 text-xs px-2"
      >
        <Plus className="h-3.5 w-3.5" />
        Add
      </Button>
      {renderPopover()}
    </>
  );
}
