import "server-only";
import { NextResponse } from "next/server";

/** Where a response's numbers come from. Books are the official business figures. */
export type ApiSource = "books" | "tracker" | "estimate";

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "RATE_LIMIT_EXCEEDED"
  | "INTERNAL_ERROR";

export interface ApiErrorDetails {
  /** Machine-readable cause, stable across releases. */
  reason?: string;
  /** What to change to make the call work. */
  hint?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details: ApiErrorDetails = {},
  ) {
    super(message);
  }
}

/** The JSON a books refusal carries after its code ('API_X {...}'), or nothing. */
function refusalDetails(message: string): Record<string, unknown> {
  const json = /\b(?:API|ACCT)_[A-Z_]+ (\{[\s\S]*\})\s*$/.exec(message)?.[1];
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Turns a database refusal into the API's error. The API_* codes come from
 * public.api_act / api_authorize and public.api_books_command; ACCT_* codes
 * from the books functions. A contact refusal carries its details as JSON
 * after the code.
 */
export function databaseError(message: string, permission: string): ApiError {
  const code = /\b(API_[A-Z_]+|ACCT_[A-Z_]+)\b/.exec(message)?.[1];
  switch (code) {
    case "API_CONTACT_DUPLICATE":
      return new ApiError(
        409,
        "CONFLICT",
        "A contact with this name already exists.",
        {
          reason: "duplicate",
          existing: refusalDetails(message).existing,
          hint: "Use the existing contact's id instead of adding another. If it is archived, tell the owner.",
        },
      );
    case "API_CONTACT_POSSIBLE_DUPLICATE":
      return new ApiError(
        409,
        "CONFLICT",
        "This contact may already exist under a similar name.",
        {
          reason: "possible_duplicate",
          candidates: refusalDetails(message).candidates,
          hint: "Check each candidate. Use one if it is the same contact; if none is, send all of their ids in not_duplicate_of and retry.",
        },
      );
    case "API_CONTACT_CONFIRMED":
      return new ApiError(
        409,
        "CONFLICT",
        "The owner approved this contact, so only the owner changes it now.",
        {
          reason: "contact_confirmed",
          hint: "Leave it as it is, or tell the owner what should change.",
        },
      );
    case "API_CONTACT_ALREADY_SET": {
      const details = refusalDetails(message);
      return new ApiError(
        409,
        "CONFLICT",
        "A transaction already has a contact, so nothing was changed.",
        {
          reason: "contact_already_set",
          entry_id: details.entry_id,
          contact: details.contact,
          hint: "Only blank contacts are filled. Leave that transaction out and retry the rest; tell the owner if its contact looks wrong.",
        },
      );
    }
    case "API_CONTACT_TRANSFER":
      return new ApiError(
        422,
        "VALIDATION_ERROR",
        "A transfer between the business's own accounts has no contact, so nothing was changed.",
        {
          reason: "transfer_no_contact",
          entry_id: refusalDetails(message).entry_id,
          hint: "Leave that transaction out and retry the rest.",
        },
      );
    case "API_MISSED_NO_GAP":
    case "API_MISSED_WRONG_DIRECTION":
    case "API_MISSED_EXCEEDS_GAP":
    case "API_MISSED_AFTER_BALANCE": {
      const details = refusalDetails(message);
      const gap = {
        gap_cents: details.gap_cents ?? null,
        bank_cents: details.bank_cents ?? null,
        bank_observed_at: details.bank_observed_at ?? null,
        closes_with_cents: details.closes_with_cents ?? null,
      };
      return code === "API_MISSED_NO_GAP"
        ? new ApiError(
            409,
            "CONFLICT",
            "The books and the bank agree on this account, so there is no missed transaction to add.",
            {
              reason: "no_gap",
              ...gap,
              hint: "Nothing is missing by the bank's last balance. If the owner says a charge is missing, it may not have reached the bank yet; tell them.",
            },
          )
        : code === "API_MISSED_WRONG_DIRECTION"
          ? new ApiError(
              422,
              "VALIDATION_ERROR",
              "This amount would widen the gap between the books and the bank.",
              {
                reason: "wrong_direction",
                ...gap,
                hint: "Check the sign: money out of the account is negative. closes_with_cents is the amount that would close the gap.",
              },
            )
          : code === "API_MISSED_EXCEEDS_GAP"
            ? new ApiError(
                422,
                "VALIDATION_ERROR",
                "This amount is larger than the gap between the books and the bank.",
                {
                  reason: "exceeds_gap",
                  ...gap,
                  hint: "Recheck the amount with the owner. closes_with_cents is the most this account is missing.",
                },
              )
            : new ApiError(
                422,
                "VALIDATION_ERROR",
                "This date is after the bank's latest balance, so the gap cannot say whether it is missing.",
                {
                  reason: "after_balance",
                  ...gap,
                  hint: "Wait for the next bank sync; if it still does not appear, add it then.",
                },
              );
    }
    case "API_MISSED_DUPLICATE":
      return new ApiError(
        409,
        "CONFLICT",
        "The same amount is already on this account within 10 days, so this is probably already recorded.",
        {
          reason: "possible_duplicate",
          candidate: refusalDetails(message).candidate,
          hint: "Show the owner the candidate. Do not add it again unless the owner says both are real; then the owner adds it in the app.",
        },
      );
    case "API_MISSED_DATE":
      return new ApiError(
        422,
        "VALIDATION_ERROR",
        "That date is in the future or before the books start.",
        {
          reason: "invalid_date",
          hint: "Use the date the bank posted it, on or before today.",
        },
      );
    case "API_KEY_INVALID":
      return new ApiError(401, "UNAUTHORIZED", "Invalid or revoked API key.", {
        reason: "invalid_api_key",
        hint: "Check the key, or ask the owner for a new one in Settings > API.",
      });
    case "API_KEY_DISABLED":
      return new ApiError(401, "UNAUTHORIZED", "This API key is disabled.", {
        reason: "api_key_disabled",
        hint: "The owner turns it back on, or issues a new key, in Settings > API.",
      });
    case "API_KEY_EXPIRED":
      return new ApiError(401, "UNAUTHORIZED", "This API key has expired.", {
        reason: "api_key_expired",
        hint: "Create a new key in Settings > API.",
      });
    case "API_MEMBER_INACTIVE":
      return new ApiError(
        403,
        "FORBIDDEN",
        "The person behind this key is suspended or has no sign-in.",
        {
          reason: "member_inactive",
          hint: "The owner reactivates this person, or gives them a sign-in, in Team.",
        },
      );
    case "API_MEMBER_NO_API":
      return new ApiError(
        403,
        "FORBIDDEN",
        "The person behind this key may not use the API.",
        {
          reason: "member_no_api",
          grant_on: "member",
          hint: "The owner grants 'Use the API' to this person in Team > Access.",
        },
      );
    case "API_SCOPE_MISSING":
      return new ApiError(
        403,
        "FORBIDDEN",
        `This key does not include ${permission}.`,
        {
          reason: "missing_key_scope",
          grant_on: "api_key",
          required: permission,
          hint: `Create a key that includes ${permission}.`,
        },
      );
    case "API_MEMBER_PERMISSION_MISSING":
      return new ApiError(
        403,
        "FORBIDDEN",
        `The person behind this key does not hold ${permission}.`,
        {
          reason: "missing_member_permission",
          grant_on: "member",
          required: permission,
          hint: `The owner grants ${permission} to this person in Team > Access.`,
        },
      );
    case "API_RATE_LIMITED":
      return new ApiError(
        429,
        "RATE_LIMIT_EXCEEDED",
        "Too many requests for this key. The limit is 120 a minute.",
        {
          reason: "rate_limited",
          hint: "Wait until the minute is up (Retry-After says how long), then retry.",
        },
      );
    case "ACCT_FORBIDDEN":
      return new ApiError(
        403,
        "FORBIDDEN",
        "The books refused this read for the person behind this key.",
        {
          reason: "books_forbidden",
          hint: "The owner checks this person's books permissions in Team > Access.",
        },
      );
    case "ACCT_STALE_VERSION":
    case "ACCT_STALE_REVISION":
      return new ApiError(
        409,
        "CONFLICT",
        "It changed since you read it. Read it again, then retry with the new version.",
        {
          reason: "stale_version",
          hint: "Read the transaction again and retry once with its current version.",
        },
      );
    case "ACCT_IDEMPOTENCY_CONFLICT":
      return new ApiError(
        409,
        "CONFLICT",
        "This Idempotency-Key was already used for a different request.",
        {
          reason: "idempotency_conflict",
          hint: "Use a new key for a different request; reuse a key only to retry the same one.",
        },
      );
    case "API_DRAFTS_ONLY":
      return new ApiError(
        403,
        "FORBIDDEN",
        "Agents can only prepare drafts. This would have posted or changed reviewed books, so nothing was saved.",
        {
          reason: "drafts_only",
          blocked: /API_DRAFTS_ONLY \(([^)]*)\)/.exec(message)?.[1],
          hint: "Leave posting to the owner, who reviews drafts in the app.",
        },
      );
    case "API_DRAFTS_NO_CASH":
      return new ApiError(
        422,
        "VALIDATION_ERROR",
        "Journal entries from the API cannot touch a bank, card or cash account.",
        {
          reason: "bank_lines_not_allowed",
          hint: "Bank and card transactions come from the feeds: categorize or split those drafts. Drafts here are adjustments between other accounts.",
        },
      );
    case "API_COMMAND_NOT_ALLOWED":
      return new ApiError(
        403,
        "FORBIDDEN",
        "This command is not available through the API.",
        {
          reason: "command_not_allowed",
          hint: "This change stays with the owner in the app.",
        },
      );
    case "ACCT_POSTED_IMMUTABLE":
    case "ACCT_IMMUTABLE":
    case "ACCT_DISCARDED":
      return new ApiError(
        409,
        "CONFLICT",
        "Only drafts can change, and this one has been reviewed or discarded.",
        {
          reason: "not_a_draft",
          hint: "It was reviewed or discarded, so it is the owner's now. Leave it and move on.",
        },
      );
    case "ACCT_TRANSFER_PAIR_CONFIRM":
    case "ACCT_MATCHED_LINE_IMMUTABLE":
    case "ACCT_BANK_SOURCE_CHANGED":
    case "ACCT_PERIOD_LOCKED":
    case "ACCT_LATER_PERIOD_LOCKED":
    case "ACCT_ACCOUNT_ARCHIVED":
    case "ACCT_ACCOUNT_CLOSED":
    case "ACCT_INVALID_LINES":
    case "ACCT_INVALID_CENTS":
    case "ACCT_UNBALANCED":
    case "ACCT_INVALID_SPLIT":
    case "ACCT_SIMPLE_MOVEMENT_REQUIRED":
    case "ACCT_TRANSFER_REQUIRED":
    case "ACCT_CATEGORY_REQUIRED":
    case "ACCT_INVALID_RULE":
    case "ACCT_INVALID_RULE_ACCOUNT":
    case "ACCT_INVALID_MONEY":
    case "ACCT_INVALID_COMMAND":
    case "ACCT_INVALID_ROLES":
    case "ACCT_IMMUTABLE_PROVENANCE":
      return new ApiError(
        422,
        "VALIDATION_ERROR",
        "The books refused this change.",
        {
          reason: "books_refused",
          books_code: code,
          hint:
            code === "ACCT_TRANSFER_PAIR_CONFIRM"
              ? "This draft is one side of a proposed transfer; the owner confirms or unpairs it in the app."
              : code === "ACCT_PERIOD_LOCKED" ||
                  code === "ACCT_LATER_PERIOD_LOCKED"
                ? "That month is closed; choose a date in an open month."
                : code === "ACCT_ACCOUNT_CLOSED"
                  ? "That bank or card account is closed (its closed_on says on which day); nothing can be dated after that day."
                  : code === "ACCT_MATCHED_LINE_IMMUTABLE" ||
                      code === "ACCT_BANK_SOURCE_CHANGED"
                    ? "Lines matched to a bank transaction keep their account, amount and date."
                    : "books_code says what the books refused; change the request rather than repeating it.",
        },
      );
    case "API_INVALID_INPUT":
      return new ApiError(
        422,
        "VALIDATION_ERROR",
        "A value is not allowed here.",
        {
          reason: "invalid_parameters",
          hint: "An account, category or contact id does not exist, is archived or does not fit here. Look it up again.",
        },
      );
    case "ACCT_TAX_RANGE":
      return new ApiError(
        422,
        "VALIDATION_ERROR",
        "These reports cover one calendar year, up to today.",
        {
          reason: "invalid_range",
          hint: "Pass year, or from and to inside one year (tax workpapers start on January 1 and end today at the latest).",
        },
      );
    case "ACCT_CONTRACTOR_YEAR_RULE_REQUIRED":
      return new ApiError(
        422,
        "VALIDATION_ERROR",
        "The books have no 1099 threshold for that year.",
        {
          reason: "invalid_range",
          hint: "The contractor worksheet covers 2022 to 2026.",
        },
      );
    case "ACCT_INVALID_FILTER":
    case "ACCT_REPORT_RANGE":
    case "ACCT_REPORT_KIND":
      return new ApiError(
        422,
        "VALIDATION_ERROR",
        "The books refused these parameters.",
        {
          reason: "invalid_parameters",
          hint: "Check the dates (from on or before to) and the filter values.",
        },
      );
    case "ACCT_NOT_FOUND":
    case "ACCT_ACCOUNT_NOT_FOUND":
      return new ApiError(404, "NOT_FOUND", "Not found.", {
        reason: "not_found",
        hint: "Check the id; search again to find the current one.",
      });
    default:
      // Two requests racing to add the same thing: the second is a duplicate.
      if (/duplicate key value violates unique constraint/i.test(message))
        return new ApiError(409, "CONFLICT", "That already exists.", {
          reason: "duplicate",
          hint: "Read it again (for a contact, search books_list_contacts) and use the one that exists.",
        });
      if (/violates (check|foreign key) constraint/i.test(message))
        return new ApiError(
          422,
          "VALIDATION_ERROR",
          "The books refused a value.",
          { reason: "invalid_parameters" },
        );
      if (
        /invalid input syntax for type (uuid|date)|date\/time field value out of range/i.test(
          message,
        )
      )
        return new ApiError(
          422,
          "VALIDATION_ERROR",
          "A parameter has the wrong format.",
          { reason: "invalid_format" },
        );
      return new ApiError(
        500,
        "INTERNAL_ERROR",
        "Something went wrong reading the data.",
        { reason: "internal" },
      );
  }
}

export function errorResponse(
  error: ApiError,
  requestId: string,
  headers: Record<string, string> = {},
) {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(Object.keys(error.details).length
          ? { details: error.details }
          : {}),
      },
      request_id: requestId,
    },
    {
      status: error.status,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
        ...headers,
      },
    },
  );
}

export function successResponse(
  source: ApiSource,
  data: unknown,
  requestId: string,
  headers: Record<string, string> = {},
  meta?: Record<string, unknown>,
) {
  return NextResponse.json(
    {
      success: true,
      source,
      data,
      ...(meta ? { meta } : {}),
      request_id: requestId,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
        ...headers,
      },
    },
  );
}
