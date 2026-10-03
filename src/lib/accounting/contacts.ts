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
