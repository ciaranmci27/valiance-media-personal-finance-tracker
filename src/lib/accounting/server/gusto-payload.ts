import { createHash } from "node:crypto";
import {
  gustoBody,
  type GustoMapping,
  type GustoReport,
} from "../gusto-import";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * One import item per Gusto run. The key is Gusto's own payroll ids (stable
 * across exports and date ranges), so the same payroll is always the same
 * record; the fingerprint is every figure the run books, so a changed export
 * of an imported payroll reads as a conflict instead of a duplicate.
 */
export function gustoItems(
  report: GustoReport,
  mapping: GustoMapping,
  choices: Record<string, string> = {},
) {
  return report.runs.map((run) => {
    const key = `Gusto ${run.check_date} ${hash(["gusto", [...run.payroll_ids].sort()])}`;
    const checks = run.checks
      .map((check) => ({ ...check, employee: check.employee.toLowerCase() }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {
      key,
      fingerprint: hash([
        run.check_date,
        run.period_from,
        run.period_to,
        checks,
      ]),
      payroll_ids: run.payroll_ids,
      body: gustoBody(run, mapping),
      ...(choices[key] ? { choice: choices[key] } : {}),
    };
  });
}
