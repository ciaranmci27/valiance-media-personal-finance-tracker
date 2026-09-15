/**
 * Team guard codes and database errors, in the owner's words. The SQL raises
 * opaque TEAM_* codes; the screens show these sentences instead.
 */
const KNOWN: Array<[RegExp, string]> = [
  [
    /TEAM_LAST_OWNER/,
    "The workspace needs at least one active owner. Make someone else an owner first.",
  ],
  [/TEAM_NOT_MEMBER/, "Your account is not part of this workspace."],
  [/TEAM_INVALID/, "Enter a name and an email address."],
  [/TEAM_FORBIDDEN/, "You do not have permission to make that change."],
  [
    /idx_team_members_email|23505|duplicate key/i,
    "Someone with that email is already on the team.",
  ],
  [
    /idx_team_members_auth_user_id/i,
    "That sign-in is already linked to another member.",
  ],
];

export function teamError(
  error: unknown,
  fallback = "Something went wrong. Nothing was saved.",
): string {
  const text =
    typeof error === "string"
      ? error
      : error && typeof error === "object"
        ? [
            (error as { code?: string }).code,
            (error as { message?: string }).message,
            (error as { details?: string }).details,
          ]
            .filter(Boolean)
            .join(" ")
        : "";
  for (const [pattern, sentence] of KNOWN) {
    if (pattern.test(text)) return sentence;
  }
  return fallback;
}
