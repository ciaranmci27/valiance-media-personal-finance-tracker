import { apiOperation } from "@/lib/api/operations";
import { withApi } from "@/lib/api/with-api";
import {
  booksClient,
  booksCommand,
  booksRead,
  contactUrl,
  nameMatches,
  pageOf,
} from "@/lib/api/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Contact {
  name: string;
  roles: string[];
  review_status: string;
  is_archived: boolean;
}

/** Contacts, through the books' reader check (accounting.payees_list), filtered, searched and paged by name. */
export const GET = withApi(
  apiOperation("books.contacts"),
  async ({ query, keyHash, service }) => {
    const result = await booksRead<{ payees: Contact[] | null }>(
      booksClient(service, keyHash),
      "payees",
      {},
    );
    const matching = (result.payees ?? [])
      .filter(
        (contact) => query.include_archived === "true" || !contact.is_archived,
      )
      .filter((contact) => !query.role || contact.roles.includes(query.role))
      .filter(
        (contact) =>
          !query.review_status || contact.review_status === query.review_status,
      )
      .filter((contact) => nameMatches(contact.name, query.q))
      .sort((a, b) => a.name.localeCompare(b.name));
    const { rows, ...page } = pageOf(matching, query);
    return { data: { ...page, contacts: rows } };
  },
);

/** Suggests a contact; the books refuse a duplicate name (public.api_contact_check). */
export const POST = withApi(
  apiOperation("books.contact_create"),
  async ({ body, idempotencyKey, keyHash, origin, service }) => {
    const result = await booksCommand(
      service,
      keyHash,
      "contact.create",
      idempotencyKey,
      body,
    );
    const id = String(result.id ?? "");
    return {
      data: {
        id,
        version: typeof result.version === "number" ? result.version : null,
        review_status: "suggested" as const,
        review_url: contactUrl(origin, id),
      },
    };
  },
);
