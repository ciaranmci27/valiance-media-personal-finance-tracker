import "server-only";
import {
  accountingQueryKey,
  type AccountingQuery,
  type PreloadedReads,
} from "../read-cache";
import { answerAccountingRead } from "./http-read";

/**
 * Reads what a screen will ask for first, answered exactly as GET
 * /api/accounting answers it, so a page can hand the answers to the browser
 * cache instead of the screen requesting them after it hydrates. A read that
 * fails is left out and the screen makes it itself, as it always has.
 */
export async function preloadAccountingReads(
  queries: AccountingQuery[],
): Promise<PreloadedReads> {
  const at = Date.now();
  const unique = new Map(queries.map((q) => [accountingQueryKey(q), q]));
  const answers = await Promise.all(
    [...unique.values()].map(async (query) => {
      try {
        const response = await answerAccountingRead(
          new URLSearchParams(query),
        );
        if (!response.ok) return null;
        return { query, value: (await response.json()) as unknown };
      } catch {
        return null;
      }
    }),
  );
  return {
    at,
    reads: answers.filter((answer) => answer !== null),
  };
}
