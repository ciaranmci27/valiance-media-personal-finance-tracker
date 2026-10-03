/** What a contact is to the business; a contact holds one or more. */
export const CONTACT_ROLES = [
  "client",
  "vendor",
  "contractor",
  "employee",
  "government",
  "financial",
  "owner",
] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];
export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
  client: "Client",
  vendor: "Vendor",
  contractor: "Contractor",
  employee: "Employee",
  government: "Government",
  financial: "Bank or financial",
  owner: "Owner",
};

/** A contact's dominant category: the account most of its money went through. */
export interface ContactTopCategory {
  id: string;
  name: string;
}

/** What grouping reads from a contact. */
export interface GroupableContact {
  roles: readonly string[];
  top_category?: ContactTopCategory | null;
  default_account_id?: string | null;
}

/** The role groups, in the order the list shows them. */
export const CONTACT_ROLE_GROUPS = [
  "Clients",
  "Contractors",
  "Owner & payroll",
  "Government",
  "Banking & financial",
] as const;
/** Vendors with no category to group them by. */
export const OTHER_VENDORS = "Other vendors";

export interface ContactGroup<T> {
  /** Stable across renders and visits: role groups, category groups and the rest never share one. */
  key: string;
  label: string;
  contacts: T[];
}

/**
 * Where a contact sits in the list. People and institutions group by role
 * (the first match wins, in this order); everyone else is a vendor, grouped
 * by the category most of its money went through, else its default
 * category, else Other vendors.
 */
export function contactGroup(
  contact: GroupableContact,
  accountName: (id: string) => string | undefined = () => undefined,
): { key: string; label: string } {
  const has = (role: ContactRole) => contact.roles.includes(role);
  const role = (label: (typeof CONTACT_ROLE_GROUPS)[number]) => ({
    key: `role:${label}`,
    label,
  });
  if (has("owner") || has("employee")) return role("Owner & payroll");
  if (has("government")) return role("Government");
  if (has("financial")) return role("Banking & financial");
  if (has("contractor")) return role("Contractors");
  if (has("client") && !has("vendor")) return role("Clients");
  const category =
    contact.top_category?.name ||
    (contact.default_account_id
      ? accountName(contact.default_account_id)
      : undefined);
  return category
    ? { key: `category:${category}`, label: category }
    : { key: "other", label: OTHER_VENDORS };
}

/**
 * Contacts in their groups: the role groups first in a fixed order, then the
 * category groups, largest first and by name on a tie, and Other vendors
 * last. Contacts keep their order inside a group; empty groups are left out.
 */
export function groupContacts<T extends GroupableContact>(
  contacts: T[],
  accountName?: (id: string) => string | undefined,
): ContactGroup<T>[] {
  const groups = new Map<string, ContactGroup<T>>();
  for (const contact of contacts) {
    const { key, label } = contactGroup(contact, accountName);
    const group = groups.get(key) ?? { key, label, contacts: [] };
    group.contacts.push(contact);
    groups.set(key, group);
  }
  const rank = (group: ContactGroup<T>) => {
    const fixed = CONTACT_ROLE_GROUPS.findIndex(
      (l) => group.key === `role:${l}`,
    );
    if (fixed >= 0) return fixed;
    return group.key === "other"
      ? CONTACT_ROLE_GROUPS.length + 1
      : CONTACT_ROLE_GROUPS.length;
  };
  return [...groups.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.contacts.length - a.contacts.length ||
      a.label.localeCompare(b.label),
  );
}
