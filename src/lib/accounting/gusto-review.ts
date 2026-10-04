import type { GustoFeeRow, GustoResult, GustoState } from "./gusto-import";

/**
 * The Gusto review screen works on units: one payroll, or several payrolls
 * that share one entry in the books. A unit has one choice, so every run in
 * a group is always imported (or skipped) together.
 */
export interface GustoUnit {
  /** The first run's key; also the key of the unit's choice. */
  key: string;
  /** YYYY-MM of the first pay date, for grouping by month. */
  month: string;
  state: GustoState;
  runs: GustoResult[];
}

export function gustoUnits(results: GustoResult[]): GustoUnit[] {
  const units = new Map<string, GustoUnit>();
  for (const result of results) {
    const key = result.group.length > 1 ? result.group[0] : result.key;
    const unit = units.get(key) ?? {
      key,
      month: result.pay_date.slice(0, 7),
      state: result.state,
      runs: [],
    };
    unit.runs.push(result);
    units.set(key, unit);
  }
  return [...units.values()]
    .map((unit) => ({
      ...unit,
      runs: unit.runs.sort((a, b) => a.pay_date.localeCompare(b.pay_date)),
      month: unit.runs
        .map((r) => r.pay_date)
        .sort()[0]
        .slice(0, 7),
    }))
    .sort(
      (a, b) =>
        a.runs[0].pay_date.localeCompare(b.runs[0].pay_date) ||
        a.key.localeCompare(b.key),
    );
}

const entryOf = (unit: GustoUnit) => unit.runs[0].entry;
export const linkChoice = (unit: GustoUnit) =>
  entryOf(unit) ? `link:${entryOf(unit)!.id}:${entryOf(unit)!.version}` : "";
export const correctChoice = (unit: GustoUnit) =>
  entryOf(unit) ? `correct:${entryOf(unit)!.id}:${entryOf(unit)!.version}` : "";

/** The unit is waiting on the owner: the books differ in date or amounts. */
export const asksForChoice = (unit: GustoUnit) =>
  unit.state === "date_match" || unit.state === "difference";

/**
 * What the screen preselects. Exact matches link and new payrolls post.
 * A difference defaults to Gusto's figures (the ones the W-2s use) when the
 * entry can be corrected. A date difference waits for the owner.
 */
export function gustoDefaultChoice(unit: GustoUnit): string | null {
  if (unit.state === "match" || unit.state === "group_match")
    return linkChoice(unit);
  if (unit.state === "new") return "new";
  if (unit.state === "difference")
    return entryOf(unit)?.can_correct ? correctChoice(unit) : linkChoice(unit);
  return null;
}

export function gustoDefaultChoices(units: GustoUnit[]) {
  const choices: Record<string, string> = {};
  for (const unit of units) {
    const choice = gustoDefaultChoice(unit);
    if (choice) choices[unit.key] = choice;
  }
  return choices;
}

/** One choice per unit, spread to every run in it, as the import route expects. */
export function gustoRunChoices(
  units: GustoUnit[],
  choices: Record<string, string>,
) {
  const out: Record<string, string> = {};
  for (const unit of units) {
    const choice = choices[unit.key];
    if (choice) for (const run of unit.runs) out[run.key] = choice;
  }
  return out;
}

export interface GustoSummary {
  payrolls: number;
  link: number;
  needChoice: number;
  posted: number;
  skipped: number;
  /** Entries the import will change (date or amounts). */
  corrections: number;
}

export function gustoSummary(
  units: GustoUnit[],
  choices: Record<string, string>,
): GustoSummary {
  const summary: GustoSummary = {
    payrolls: 0,
    link: 0,
    needChoice: 0,
    posted: 0,
    skipped: 0,
    corrections: 0,
  };
  for (const unit of units) {
    const n = unit.runs.length;
    const choice = choices[unit.key];
    summary.payrolls += n;
    if (choice === "new") summary.posted += n;
    else if (choice) {
      summary.link += n;
      if (choice.startsWith("correct:")) summary.corrections += 1;
    } else if (asksForChoice(unit)) summary.needChoice += n;
    else summary.skipped += n;
  }
  return summary;
}

const FEE_LABEL = {
  fee: ["fee", "fees"],
  fee_refund: ["fee refund", "fee refunds"],
  tax_refund: ["tax refund", "tax refunds"],
} as const;

/** Rows the screen preselects: every one that can move. */
export const gustoFeeDefaults = (rows: GustoFeeRow[]) =>
  rows.filter((r) => !r.blocked && r.to_account_id).map((r) => r.id);

/**
 * One plain line for the chosen fee moves, grouped by kind and accounts:
 * "12 fees ($620.04) move from Computer - Software to Payroll fees; 1 tax
 * refund ($4.90) moves from Computer - Software to Payroll Employer Taxes."
 */
export function gustoFeeSummary(
  rows: GustoFeeRow[],
  selected: ReadonlySet<string>,
  name: (accountId: string) => string,
  money: (cents: bigint) => string,
): string {
  const groups = new Map<
    string,
    {
      kind: GustoFeeRow["kind"];
      from: string;
      to: string;
      n: number;
      cents: bigint;
    }
  >();
  for (const row of rows) {
    if (!selected.has(row.id) || !row.to_account_id) continue;
    const key = `${row.kind}|${row.from_account_id}|${row.to_account_id}`;
    const amount = BigInt(row.amount_cents);
    const group = groups.get(key) ?? {
      kind: row.kind,
      from: row.from_account_id,
      to: row.to_account_id,
      n: 0,
      cents: BigInt(0),
    };
    group.n += 1;
    group.cents += amount < BigInt(0) ? -amount : amount;
    groups.set(key, group);
  }
  if (!groups.size) return "";
  return `${[...groups.values()]
    .map(
      (g) =>
        `${g.n} ${FEE_LABEL[g.kind][g.n === 1 ? 0 : 1]} (${money(g.cents)}) ${g.n === 1 ? "moves" : "move"} from ${name(g.from)} to ${name(g.to)}`,
    )
    .join("; ")}.`;
}
