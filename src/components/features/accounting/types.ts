import type { ManageData } from "@/lib/accounting/workflows";

/**
 * The books metadata the screens read: account profiles, parties, locked
 * periods and preferences. Anything else the server type carries stays
 * out of the components.
 */
export type BooksMetadata = Pick<
  ManageData,
  "profiles" | "parties" | "periods" | "preferences"
>;
