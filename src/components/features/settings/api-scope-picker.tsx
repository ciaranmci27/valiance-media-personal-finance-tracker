"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { API_SCOPES, type ApiScope } from "@/lib/api/scopes";

const GROUPS = [
  { access: "read", title: "Can read" },
  { access: "write", title: "Can change" },
] as const;

interface ApiScopePickerProps {
  /** Scopes the key's member holds; the rest are shown disabled with `notHeld`. */
  holdable: readonly string[];
  selected: readonly string[];
  onChange: (next: ApiScope[]) => void;
  /** Why a scope cannot be ticked, e.g. "Alex A. does not have this permission." */
  notHeld: string;
}

/**
 * What a key can read or change, grouped, for New key and Edit key. A
 * scope the member does not hold is disabled with the reason. One that is
 * ticked anyway (the member lost the permission after the key was made) stays
 * enabled so it can be unticked: the key cannot be saved with it.
 */
export function ApiScopePicker({ holdable, selected, onChange, notHeld }: ApiScopePickerProps) {
  const isSelected = (key: ApiScope) => selected.includes(key);
  const current = API_SCOPES.map((s) => s.key).filter(isSelected);

  const toggle = (scope: ApiScope, checked: boolean) =>
    onChange(checked ? [...current, scope] : current.filter((s) => s !== scope));

  const toggleGroup = (access: "read" | "write") => {
    const group = API_SCOPES.filter((s) => s.access === access && holdable.includes(s.key)).map((s) => s.key);
    const all = group.every(isSelected);
    onChange(
      all
        ? current.filter((key) => !group.includes(key))
        : [...current, ...group.filter((key) => !isSelected(key))],
    );
  };

  return (
    <>
      {GROUPS.map(({ access, title }) => {
        const group = API_SCOPES.filter((scope) => scope.access === access);
        const groupHeld = group.filter((scope) => holdable.includes(scope.key));
        const allOn = groupHeld.length > 0 && groupHeld.every((scope) => isSelected(scope.key));
        return (
          <fieldset key={access} className="space-y-2">
            {/* A legend names the group only as the fieldset's first child, so the visible title is a twin. */}
            <legend className="sr-only">{title}</legend>
            <div className="flex items-center justify-between gap-3">
              <span aria-hidden="true" className="text-sm font-medium text-foreground">
                {title}
              </span>
              {groupHeld.length > 1 && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  aria-label={`${allOn ? "Clear" : "Select all"}, ${title.toLowerCase()}`}
                  onClick={() => toggleGroup(access)}
                >
                  {allOn ? "Clear" : "Select all"}
                </Button>
              )}
            </div>
            <div className="space-y-2 rounded-xl border border-border p-3">
              {group.map((scope) => {
                const held = holdable.includes(scope.key);
                const checked = isSelected(scope.key);
                return (
                  <div key={scope.key}>
                    <Checkbox
                      checked={checked}
                      disabled={!held && !checked}
                      onChange={(next) => toggle(scope.key, next)}
                      label={scope.label}
                      description={
                        held ? scope.description : checked ? `${notHeld} Untick it to save.` : notHeld
                      }
                    />
                  </div>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </>
  );
}
