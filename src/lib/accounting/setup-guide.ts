/**
 * The setup guide: what the books still need from the owner, as one ordered
 * list. Every step closes its own loop: the data proves it is done, or the
 * owner says so, and usually both. Pure: the route feeds it the feed state
 * and the year's counts, and every screen renders the first open step.
 */
import type { FeedData } from "./feeds";
import { accountingHref } from "./views";
import {
  defaultClassification,
  type EntityType,
} from "@/lib/business-classification";

export type SetupLevel = "critical" | "warning" | "info";

export type SetupTarget =
  | { kind: "link"; href: string }
  /** Opens the rule-based treatment review wherever the guide is shown. */
  | { kind: "treatments" };

export interface SetupStep {
  key: string;
  level: SetupLevel;
  /** The owner's action, in their words. */
  title: string;
  /** What to do, on which screen, and what happens. */
  detail: string;
  action: { label: string; target: SetupTarget };
  /** Absent on critical steps: those only clear from the data. */
  acknowledge?: { key: string; label: string };
  /** Set once the owner acknowledged it; listed under done, reversible. */
  acknowledged?: { at: string };
}

/** `accounting.setup_status(year, cutoff)`: the year's counts in one read. */
export interface SetupStatus {
  year: number;
  through: string;
  revision: string;
  primary_system: "wave" | "admin";
  /** The owner's acknowledgements, keyed like `SetupStep.acknowledge.key`. */
  acknowledged: Record<string, { at: string; by?: string }>;
  accounts_total: number;
  /** The purposes the sync and transfers rely on that no account carries. */
  missing_purposes: string[];
  profile: {
    legal_name: string;
    entity_type: string;
    classification: string;
    since: number | null;
    timezone: string;
    history_start: string;
  } | null;
  unmapped_accounts: number;
  /** Posted runs this year whose provider register is missing or archived. */
  runs_without_register: number;
}

export interface SetupGuideData {
  year: number;
  /** The cutoff the counts cover; the treatment review reads through it. */
  through: string;
  steps: SetupStep[];
}

/** A feed's mapping reminder is a step of its own, not a sync failure. */
const MAPPING_ERROR = "Discover and review the company account mappings";

const PURPOSE_NAMES: Record<string, string> = {
  uncategorized_income: "an Uncategorized income account",
  uncategorized_expense: "an Uncategorized expense account",
  transfers_in_transit: "a Transfers in transit account",
};

const ENTITY_WORDS: Record<string, string> = {
  llc: "an LLC",
  corporation: "a corporation",
  sole_proprietorship: "a sole proprietorship",
  partnership: "a partnership",
};

const CLASSIFICATION_WORDS: Record<string, string> = {
  sole_prop: "a sole proprietor",
  disregarded: "a disregarded entity",
  s_corp: "an S-Corp",
  c_corp: "a C-Corp",
  partnership: "a partnership",
};

/**
 * A short, stable digest of whatever an acknowledgement answers, so the
 * answer expires when the facts change. FNV-1a, base36, never security.
 */
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function plural(n: number, singular: string, pluralForm = `${singular}s`) {
  return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Shown when the owner row does not exist yet: nothing else can be read. */
export function claimGuide(year: number): SetupGuideData {
  return {
    year,
    through: "",
    steps: [
      {
        key: "claim",
        level: "critical",
        title: "Set up your books",
        detail:
          "Accounting needs a one-time owner setup. Open Accounting and follow the two steps shown there.",
        action: { label: "Accounting", target: { kind: "link", href: "/accounting" } },
      },
    ],
  };
}

export function buildSetupGuide({
  year,
  feeds,
  status,
}: {
  year: number;
  feeds: FeedData | null;
  status: SetupStatus;
}): SetupGuideData {
  const steps: SetupStep[] = [];
  const feedsHref = accountingHref("settings", "feeds");
  const accountsHref = accountingHref("accounts");
  const yearKey = (key: string) => `${key}:${year}`;
  const acknowledged = status.acknowledged ?? {};
  // An earlier answer for the same step, given about a different state.
  const changedSince = (prefix: string, key: string) =>
    Object.keys(acknowledged).some((k) => k.startsWith(`${prefix}:`) && k !== key);

  if (status.accounts_total === 0)
    steps.push({
      key: "chart",
      level: "critical",
      title: "Set up your chart of accounts",
      detail:
        "The books have no accounts yet. Accounts can seed the standard chart in one click, or bring yours in from Wave under Settings, Data.",
      action: { label: "Accounts", target: { kind: "link", href: accountsHref } },
    });
  else if ((status.missing_purposes ?? []).length > 0)
    steps.push({
      key: "system-accounts",
      level: "critical",
      title: "Assign the accounts the books rely on",
      detail: `Bank syncing and transfers need ${list(status.missing_purposes.map((p) => PURPOSE_NAMES[p] ?? p.replace(/_/g, " ")))}. On Accounts, open the account, expand Advanced and pick its purpose.`,
      action: { label: "Accounts", target: { kind: "link", href: accountsHref } },
    });

  if (status.profile) {
    const p = status.profile;
    const elected =
      CLASSIFICATION_WORDS[p.classification]?.replace(/^an? /, "") ??
      p.classification;
    const election =
      p.since !== null && p.since > year
        ? ` Business settings says the ${elected} election starts in ${p.since}, after ${year}.`
        : p.since === null &&
            p.classification !== defaultClassification(p.entity_type as EntityType)
          ? ` Set the year the ${elected} election took effect; until then every year is taxed that way.`
          : "";
    const profileKey = `profile:${fingerprint([p.legal_name, p.entity_type, p.classification, p.since, p.timezone, p.history_start])}`;
    const changed = changedSince("profile", profileKey)
      ? " These changed since you last confirmed them."
      : "";
    steps.push({
      key: "profile",
      level: "warning",
      title: "Check your business details",
      detail: `${p.legal_name}, ${ENTITY_WORDS[p.entity_type] ?? p.entity_type} taxed as ${CLASSIFICATION_WORDS[p.classification] ?? p.classification.replace(/_/g, " ")}, books in ${p.timezone.replace(/_/g, " ")} from ${longDate(p.history_start)}.${election} Change anything in Business settings, or confirm it here.${changed}`,
      action: { label: "Business settings", target: { kind: "link", href: "/settings/business" } },
      acknowledge: { key: profileKey, label: "Looks right" },
    });
  }

  if (feeds && feeds.connections.length === 0)
    steps.push({
      key: "connect",
      level: "warning",
      title: "Connect your bank",
      detail:
        "Nothing is pulled in until a bank feed is connected. Bank feeds takes a SimpleFIN setup token, discovers your accounts, and you map each one to a book account.",
      action: { label: "Bank feeds", target: { kind: "link", href: feedsHref } },
      acknowledge: { key: "connect", label: "Not using bank feeds" },
    });

  if (feeds) {
    const active = feeds.connections.filter((c) => c.status === "active");
    const reconnect = feeds.connections.filter(
      (c) => c.status === "reconnect_required",
    );
    const unreviewed = feeds.identities.filter(
      (i) =>
        i.ownership === "unreviewed" &&
        !i.feed_account_id &&
        active.some((c) => c.id === i.connection_id),
    );
    const mapped = feeds.accounts.length;

    for (const connection of reconnect)
      steps.push({
        key: `reconnect:${connection.id}`,
        level: "critical",
        title: `Reconnect ${connection.name}`,
        detail:
          "The bank feed lost its access and nothing syncs until it is connected again with a new SimpleFIN token.",
        action: { label: "Bank feeds", target: { kind: "link", href: feedsHref } },
      });

    if (unreviewed.length > 0 && mapped === 0) {
      const institutions = [
        ...new Set(unreviewed.map((i) => i.institution).filter(Boolean)),
      ];
      steps.push({
        key: "mapping",
        level: "critical",
        title: "Map your bank accounts to start syncing",
        detail: `${plural(unreviewed.length, "account was", "accounts were")} discovered${institutions.length ? ` from ${institutions.join(" and ")}` : ""}. Nothing is pulled in until each one is mapped to a book account, or marked personal or ignored.`,
        action: { label: "Map accounts", target: { kind: "link", href: feedsHref } },
      });
    } else if (unreviewed.length > 0) {
      const partialKey = `mapping-partial:${fingerprint(unreviewed.map((i) => i.id).sort())}`;
      const changed = changedSince("mapping-partial", partialKey)
        ? " New accounts were discovered since you last looked."
        : "";
      steps.push({
        key: "mapping-partial",
        level: "warning",
        title: `${plural(unreviewed.length, "discovered account still needs", "discovered accounts still need")} a decision`,
        detail: `They are not syncing. Map each one to a book account, or mark it personal or ignored.${changed}`,
        action: { label: "Review accounts", target: { kind: "link", href: feedsHref } },
        acknowledge: { key: partialKey, label: "Leave them" },
      });
    }

    for (const connection of active) {
      const error = connection.last_error.trim();
      if (!error || error.startsWith(MAPPING_ERROR)) continue;
      const syncKey = `sync-${connection.id}:${fingerprint(error)}`;
      const changed = changedSince(`sync-${connection.id}`, syncKey)
        ? " The error changed since you dismissed it."
        : "";
      steps.push({
        key: `sync:${connection.id}`,
        level: "warning",
        title: `${connection.name} could not finish its last sync`,
        detail: `${error}${changed}`,
        action: { label: "Bank feeds", target: { kind: "link", href: feedsHref } },
        acknowledge: { key: syncKey, label: "Dismiss" },
      });
    }
  }

  if (status.primary_system !== "admin")
    steps.push({
      key: "primary",
      level: "info",
      title: "Wave is still the system of record",
      detail:
        "Rules only fill drafts and never post while another system is primary. Switch when these books are ready to take over.",
      action: {
        label: "Book settings",
        target: { kind: "link", href: accountingHref("settings", "settings") },
      },
      // "For now" is a year, not forever.
      acknowledge: { key: yearKey("primary"), label: "Keep Wave for now" },
    });

  if (status.unmapped_accounts > 0)
    steps.push({
      key: "treatments",
      level: "warning",
      title: `Give ${plural(status.unmapped_accounts, "account")} a tax treatment for ${year}`,
      detail: `They have ${year} activity but no treatment, so business profit from the books is held back. Suggest treatments proposes one per account from its purpose and name; you confirm or change each.`,
      action: { label: "Suggest treatments", target: { kind: "treatments" } },
      acknowledge: { key: yearKey("treatments"), label: "Skip this year" },
    });

  if (status.runs_without_register > 0)
    steps.push({
      key: "payroll-registers",
      level: "info",
      title: `Attach the Patriot register to ${plural(status.runs_without_register, "payroll run")}`,
      detail:
        "Runs without their register cannot be checked against the provider. Open each run on the Payroll screen and attach it.",
      action: {
        label: "Payroll",
        target: { kind: "link", href: accountingHref("records", "payroll") },
      },
      acknowledge: { key: yearKey("payroll-registers"), label: "Skip this year" },
    });

  for (const step of steps) {
    const at = step.acknowledge && acknowledged[step.acknowledge.key]?.at;
    if (at) step.acknowledged = { at };
  }

  return { year, through: status.through, steps };
}
