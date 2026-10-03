/**
 * Top-N for a report's rows, for the API: inside each section (between a
 * section heading, or the start, and the subtotal or total that closes it),
 * the account rows are sorted biggest first by their first value, the first
 * `top` are kept, and the rest become one "Other" row worth the closing row
 * less the rows kept. So the rows shown still add up to the section's total,
 * whatever the total covers (the customer report's total also counts income
 * from contacts it does not list). Group headings inside a section go, since
 * sorting breaks the grouping. Pure, so the test suites can call it.
 */
export interface TopRow {
  key: string;
  label: string;
  kind: "heading" | "account" | "subtotal" | "total";
  code?: string;
  values: string[];
}

const INTEGER = /^-?\d+$/;

function minus(total: string[], kept: TopRow[]): string[] {
  return total.map((value, column) => {
    if (!INTEGER.test(value)) return "";
    let rest = BigInt(value);
    for (const row of kept) {
      const cell = row.values[column] ?? "0";
      if (!INTEGER.test(cell)) return "";
      rest -= BigInt(cell);
    }
    return rest.toString();
  });
}

function first(row: TopRow): bigint {
  const value = row.values[0] ?? "0";
  return INTEGER.test(value) ? BigInt(value) : BigInt(0);
}

export function topRows<T extends TopRow>(
  rows: T[],
  top: number,
  noun: { one: string; many: string },
): TopRow[] {
  const out: TopRow[] = [];
  let section: T[] | null = null;
  let others = 0;
  const close = (closing: T) => {
    const sorted = [...(section ?? [])].sort((a, b) => {
      const x = first(a),
        y = first(b);
      return x === y ? a.label.localeCompare(b.label) : y > x ? 1 : -1;
    });
    const kept = sorted.slice(0, top);
    out.push(...kept);
    const dropped = sorted.length - kept.length;
    if (dropped > 0)
      out.push({
        key: `other-${++others}`,
        label: `Other (${dropped} ${dropped === 1 ? noun.one : noun.many})`,
        kind: "account",
        values: minus(closing.values, kept),
      });
    out.push(closing);
    section = null;
  };
  for (const row of rows) {
    if (section === null) {
      if (row.kind === "heading") {
        out.push(row);
        section = [];
      } else if (row.kind === "account") section = [row];
      else out.push(row);
      continue;
    }
    if (row.kind === "heading") continue;
    if (row.kind === "account") section.push(row);
    else close(row);
  }
  // A section with no closing row keeps its rows as they were.
  if (section) out.push(...(section as T[]));
  return out;
}
