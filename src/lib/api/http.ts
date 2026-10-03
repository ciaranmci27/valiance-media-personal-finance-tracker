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

/**
 * Turns a database refusal into the API's error. The API_* codes come from
 * public.api_act / api_authorize; ACCT_* codes from the books functions.
 */
export function databaseError(message: string, permission: string): ApiError {
  const code = /\b(API_[A-Z_]+|ACCT_[A-Z_]+)\b/.exec(message)?.[1];
  switch (code) {
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
          hint: "An account, category or payee id does not exist or does not fit here. Look it up again.",
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
