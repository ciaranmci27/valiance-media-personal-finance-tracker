import { createHash } from "node:crypto";
import {
  patriotBody,
  type PatriotMapping,
  type PatriotReport,
} from "../patriot-import";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function patriotItems(
  report: PatriotReport,
  mapping: PatriotMapping,
  choices: Record<string, string> = {},
) {
  return report.groups.map((group) => {
    const key = `Patriot ${group.pay_date} ${hash([report.company_id, group.pay_date, group.period_from, group.period_to])}`;
    const checks = group.checks.map((check) => ({
      ...check,
      employee: check.employee.toLowerCase(),
    }));
    checks.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {
      key,
      fingerprint: hash(checks),
      body: patriotBody(group, mapping),
      ...(choices[key] ? { choice: choices[key] } : {}),
    };
  });
}
