/**
 * Demo data for the personal finance app
 *
 * This data is used when NEXT_PUBLIC_DEMO_MODE=true
 * It showcases realistic data for an entrepreneur/freelancer
 */

import type {
  IncomeSource,
  IncomeEntry,
  IncomeAmount,
  Expense,
  ExpenseHistory,
  NetWorth,
  AutomationWithActions,
  AutomationRun,
  Notification,
} from "@/types/database";

// Helper to generate UUIDs (deterministic for demo)
const uuid = (seed: string) => `demo-${seed}-0000-0000-000000000000`;

// Helper to get month string (YYYY-MM-01)
const getMonth = (monthsAgo: number) => {
  const date = new Date();
  date.setMonth(date.getMonth() - monthsAgo);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
};

// Helper to get date string (YYYY-MM-DD)
const getDate = (daysAgo: number) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split("T")[0];
};

// Helper to get ISO datetime string
const getDateTime = (daysAgo: number, hour: number = 9) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
};

// ============================================
// INCOME SOURCES (including inactive)
// ============================================
export const demoIncomeSources: IncomeSource[] = [
  {
    id: uuid("source-1"),
    name: "Consulting",
    slug: "consulting",
    color: "#5B8A8A",
    sort_order: 0,
    is_active: true,
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("source-2"),
    name: "SaaS Revenue",
    slug: "saas-revenue",
    color: "#D4A574",
    sort_order: 1,
    is_active: true,
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("source-3"),
    name: "Course Sales",
    slug: "course-sales",
    color: "#7B9E87",
    sort_order: 2,
    is_active: true,
    deleted_at: null,
    created_at: "2023-06-01T00:00:00Z",
    updated_at: "2023-06-01T00:00:00Z",
  },
  {
    id: uuid("source-4"),
    name: "Affiliate Income",
    slug: "affiliate",
    color: "#9B7B9E",
    sort_order: 3,
    is_active: true,
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("source-5"),
    name: "YouTube AdSense",
    slug: "youtube",
    color: "#E57373",
    sort_order: 4,
    is_active: true,
    deleted_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: uuid("source-6"),
    name: "Sponsorships",
    slug: "sponsorships",
    color: "#64B5F6",
    sort_order: 5,
    is_active: true,
    deleted_at: null,
    created_at: "2024-03-01T00:00:00Z",
    updated_at: "2024-03-01T00:00:00Z",
  },
  // Inactive source
  {
    id: uuid("source-7"),
    name: "Freelance Writing",
    slug: "freelance-writing",
    color: "#FFB74D",
    sort_order: 6,
    is_active: false,
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2024-06-01T00:00:00Z",
  },
  {
    id: uuid("source-8"),
    name: "Workshop Fees",
    slug: "workshops",
    color: "#81C784",
    sort_order: 7,
    is_active: false,
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2024-03-01T00:00:00Z",
  },
];

// ============================================
// INCOME ENTRIES (last 72 months - back to 2020)
// ============================================
export const demoIncomeEntries: IncomeEntry[] = Array.from({ length: 72 }, (_, i) => ({
  id: uuid(`entry-${i}`),
  month: getMonth(i),
  notes: i === 0
    ? "Great month! Landed a big consulting client and course launch went well."
    : i === 3
    ? "Slow month - took some time off for vacation."
    : i === 6
    ? "Course launch month - big spike in sales!"
    : i === 12
    ? "One year milestone - business is growing steadily."
    : i === 24
    ? "Two years in! Revenue has doubled since starting."
    : i === 36
    ? "Three year mark - hit six figures this year!"
    : i === 48
    ? "Four years - diversified income streams paying off."
    : i === 60
    ? "Five years of tracking. What a journey!"
    : i === 71
    ? "The beginning - just starting to track finances."
    : null,
  deleted_at: null,
  created_at: getMonth(i) + "T00:00:00Z",
  updated_at: getMonth(i) + "T00:00:00Z",
}));

// ============================================
// INCOME AMOUNTS (realistic variation over 72 months - back to 2020)
// Shows business growth from small freelancer to established entrepreneur
// ============================================
const incomeData = [
  // Year 6 (current year - 2026) - established business
  // Month 0 (current) - strong month
  { consulting: 12500, saas: 5850, courses: 3100, affiliate: 880, youtube: 420, sponsorships: 2500 },
  // Month 1
  { consulting: 8000, saas: 5720, courses: 1850, affiliate: 720, youtube: 380, sponsorships: 0 },
  // Month 2
  { consulting: 15000, saas: 5580, courses: 980, affiliate: 610, youtube: 350, sponsorships: 1500 },
  // Month 3 - slow month
  { consulting: 4500, saas: 5410, courses: 520, affiliate: 490, youtube: 320, sponsorships: 0 },
  // Month 4
  { consulting: 9200, saas: 5280, courses: 1560, affiliate: 720, youtube: 290, sponsorships: 2000 },
  // Month 5
  { consulting: 11000, saas: 5150, courses: 890, affiliate: 580, youtube: 310, sponsorships: 0 },
  // Month 6 - course launch
  { consulting: 7800, saas: 4980, courses: 8450, affiliate: 940, youtube: 280, sponsorships: 3000 },
  // Month 7
  { consulting: 10500, saas: 4820, courses: 2120, affiliate: 610, youtube: 250, sponsorships: 0 },
  // Month 8
  { consulting: 5500, saas: 4650, courses: 1890, affiliate: 380, youtube: 220, sponsorships: 1000 },
  // Month 9
  { consulting: 8900, saas: 4480, courses: 760, affiliate: 520, youtube: 200, sponsorships: 0 },
  // Month 10
  { consulting: 12000, saas: 4320, courses: 2100, affiliate: 690, youtube: 180, sponsorships: 0 },
  // Month 11
  { consulting: 6800, saas: 4150, courses: 1450, affiliate: 410, youtube: 150, sponsorships: 0 },

  // Year 5 (2025) - strong growth year
  // Month 12 - one year mark
  { consulting: 9500, saas: 3980, courses: 1200, affiliate: 550, youtube: 120, sponsorships: 0 },
  // Month 13
  { consulting: 7200, saas: 3820, courses: 980, affiliate: 480, youtube: 100, sponsorships: 0 },
  // Month 14
  { consulting: 11500, saas: 3650, courses: 1650, affiliate: 620, youtube: 80, sponsorships: 0 },
  // Month 15
  { consulting: 6000, saas: 3480, courses: 720, affiliate: 390, youtube: 0, sponsorships: 0 },
  // Month 16
  { consulting: 8800, saas: 3320, courses: 1100, affiliate: 510, youtube: 0, sponsorships: 0 },
  // Month 17
  { consulting: 10200, saas: 3150, courses: 890, affiliate: 440, youtube: 0, sponsorships: 0 },
  // Month 18
  { consulting: 5800, saas: 2980, courses: 650, affiliate: 380, youtube: 0, sponsorships: 0 },
  // Month 19
  { consulting: 9100, saas: 2820, courses: 1200, affiliate: 520, youtube: 0, sponsorships: 0 },
  // Month 20
  { consulting: 7500, saas: 2650, courses: 980, affiliate: 460, youtube: 0, sponsorships: 0 },
  // Month 21
  { consulting: 12500, saas: 2480, courses: 1450, affiliate: 580, youtube: 0, sponsorships: 0 },
  // Month 22
  { consulting: 6200, saas: 2320, courses: 720, affiliate: 350, youtube: 0, sponsorships: 0 },
  // Month 23
  { consulting: 8400, saas: 2150, courses: 890, affiliate: 420, youtube: 0, sponsorships: 0 },

  // Year 4 (2024) - scaling up
  // Month 24
  { consulting: 7800, saas: 1980, courses: 1100, affiliate: 380, youtube: 0, sponsorships: 0 },
  // Month 25
  { consulting: 9200, saas: 1850, courses: 650, affiliate: 290, youtube: 0, sponsorships: 0 },
  // Month 26
  { consulting: 5500, saas: 1720, courses: 1800, affiliate: 410, youtube: 0, sponsorships: 0 },
  // Month 27
  { consulting: 11000, saas: 1620, courses: 520, affiliate: 320, youtube: 0, sponsorships: 0 },
  // Month 28
  { consulting: 6800, saas: 1510, courses: 890, affiliate: 250, youtube: 0, sponsorships: 0 },
  // Month 29
  { consulting: 8500, saas: 1420, courses: 720, affiliate: 380, youtube: 0, sponsorships: 0 },
  // Month 30 - big course launch
  { consulting: 4200, saas: 1350, courses: 6200, affiliate: 520, youtube: 0, sponsorships: 0 },
  // Month 31
  { consulting: 9800, saas: 1280, courses: 1450, affiliate: 290, youtube: 0, sponsorships: 0 },
  // Month 32
  { consulting: 7100, saas: 1190, courses: 980, affiliate: 410, youtube: 0, sponsorships: 0 },
  // Month 33
  { consulting: 10500, saas: 1120, courses: 650, affiliate: 350, youtube: 0, sponsorships: 0 },
  // Month 34
  { consulting: 5900, saas: 1050, courses: 1200, affiliate: 280, youtube: 0, sponsorships: 0 },
  // Month 35
  { consulting: 8200, saas: 980, courses: 890, affiliate: 390, youtube: 0, sponsorships: 0 },

  // Year 3 (2023) - building momentum
  // Month 36
  { consulting: 6500, saas: 920, courses: 520, affiliate: 220, youtube: 0, sponsorships: 0 },
  // Month 37
  { consulting: 9100, saas: 850, courses: 780, affiliate: 310, youtube: 0, sponsorships: 0 },
  // Month 38
  { consulting: 4800, saas: 790, courses: 450, affiliate: 180, youtube: 0, sponsorships: 0 },
  // Month 39
  { consulting: 7500, saas: 720, courses: 920, affiliate: 290, youtube: 0, sponsorships: 0 },
  // Month 40
  { consulting: 8800, saas: 680, courses: 380, affiliate: 240, youtube: 0, sponsorships: 0 },
  // Month 41
  { consulting: 5200, saas: 620, courses: 650, affiliate: 320, youtube: 0, sponsorships: 0 },
  // Month 42 - first course launch!
  { consulting: 6100, saas: 580, courses: 4500, affiliate: 410, youtube: 0, sponsorships: 0 },
  // Month 43
  { consulting: 9500, saas: 540, courses: 1200, affiliate: 250, youtube: 0, sponsorships: 0 },
  // Month 44
  { consulting: 4500, saas: 490, courses: 580, affiliate: 180, youtube: 0, sponsorships: 0 },
  // Month 45
  { consulting: 7800, saas: 450, courses: 420, affiliate: 290, youtube: 0, sponsorships: 0 },
  // Month 46
  { consulting: 6200, saas: 410, courses: 680, affiliate: 220, youtube: 0, sponsorships: 0 },
  // Month 47
  { consulting: 8900, saas: 380, courses: 350, affiliate: 310, youtube: 0, sponsorships: 0 },

  // Year 2 (2022) - SaaS launch, growing affiliate
  // Month 48
  { consulting: 5800, saas: 320, courses: 0, affiliate: 180, youtube: 0, sponsorships: 0 },
  // Month 49
  { consulting: 7200, saas: 280, courses: 0, affiliate: 220, youtube: 0, sponsorships: 0 },
  // Month 50
  { consulting: 4100, saas: 240, courses: 0, affiliate: 150, youtube: 0, sponsorships: 0 },
  // Month 51 - SaaS launch month
  { consulting: 6800, saas: 180, courses: 0, affiliate: 290, youtube: 0, sponsorships: 0 },
  // Month 52
  { consulting: 5500, saas: 120, courses: 0, affiliate: 180, youtube: 0, sponsorships: 0 },
  // Month 53
  { consulting: 8200, saas: 80, courses: 0, affiliate: 240, youtube: 0, sponsorships: 0 },
  // Month 54
  { consulting: 4800, saas: 0, courses: 0, affiliate: 150, youtube: 0, sponsorships: 0 },
  // Month 55
  { consulting: 6100, saas: 0, courses: 0, affiliate: 210, youtube: 0, sponsorships: 0 },
  // Month 56
  { consulting: 7500, saas: 0, courses: 0, affiliate: 180, youtube: 0, sponsorships: 0 },
  // Month 57
  { consulting: 3800, saas: 0, courses: 0, affiliate: 120, youtube: 0, sponsorships: 0 },
  // Month 58
  { consulting: 5200, saas: 0, courses: 0, affiliate: 190, youtube: 0, sponsorships: 0 },
  // Month 59
  { consulting: 6800, saas: 0, courses: 0, affiliate: 140, youtube: 0, sponsorships: 0 },

  // Year 1 (2021) - freelance consulting, starting affiliate
  // Month 60
  { consulting: 4500, saas: 0, courses: 0, affiliate: 80, youtube: 0, sponsorships: 0 },
  // Month 61
  { consulting: 5800, saas: 0, courses: 0, affiliate: 120, youtube: 0, sponsorships: 0 },
  // Month 62
  { consulting: 3200, saas: 0, courses: 0, affiliate: 60, youtube: 0, sponsorships: 0 },
  // Month 63
  { consulting: 6100, saas: 0, courses: 0, affiliate: 90, youtube: 0, sponsorships: 0 },
  // Month 64
  { consulting: 4200, saas: 0, courses: 0, affiliate: 50, youtube: 0, sponsorships: 0 },
  // Month 65
  { consulting: 5500, saas: 0, courses: 0, affiliate: 70, youtube: 0, sponsorships: 0 },
  // Month 66
  { consulting: 3800, saas: 0, courses: 0, affiliate: 40, youtube: 0, sponsorships: 0 },
  // Month 67
  { consulting: 4800, saas: 0, courses: 0, affiliate: 0, youtube: 0, sponsorships: 0 },
  // Month 68
  { consulting: 5200, saas: 0, courses: 0, affiliate: 0, youtube: 0, sponsorships: 0 },
  // Month 69
  { consulting: 2800, saas: 0, courses: 0, affiliate: 0, youtube: 0, sponsorships: 0 },
  // Month 70
  { consulting: 4100, saas: 0, courses: 0, affiliate: 0, youtube: 0, sponsorships: 0 },
  // Month 71 - the beginning (early 2020)
  { consulting: 3500, saas: 0, courses: 0, affiliate: 0, youtube: 0, sponsorships: 0 },
];

export const demoIncomeAmounts: (IncomeAmount & { income_entries: { month: string; deleted_at: string | null } })[] =
  demoIncomeEntries.flatMap((entry, monthIndex) => {
    const data = incomeData[monthIndex];
    const amounts: (IncomeAmount & { income_entries: { month: string; deleted_at: string | null } })[] = [];

    // Active sources
    if (data.consulting > 0) {
      amounts.push({
        id: uuid(`amount-${monthIndex}-consulting`),
        entry_id: entry.id,
        source_id: demoIncomeSources[0].id,
        amount: data.consulting,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        income_entries: { month: entry.month, deleted_at: null },
      });
    }
    if (data.saas > 0) {
      amounts.push({
        id: uuid(`amount-${monthIndex}-saas`),
        entry_id: entry.id,
        source_id: demoIncomeSources[1].id,
        amount: data.saas,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        income_entries: { month: entry.month, deleted_at: null },
      });
    }
    if (data.courses > 0) {
      amounts.push({
        id: uuid(`amount-${monthIndex}-courses`),
        entry_id: entry.id,
        source_id: demoIncomeSources[2].id,
        amount: data.courses,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        income_entries: { month: entry.month, deleted_at: null },
      });
    }
    if (data.affiliate > 0) {
      amounts.push({
        id: uuid(`amount-${monthIndex}-affiliate`),
        entry_id: entry.id,
        source_id: demoIncomeSources[3].id,
        amount: data.affiliate,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        income_entries: { month: entry.month, deleted_at: null },
      });
    }
    if (data.youtube > 0) {
      amounts.push({
        id: uuid(`amount-${monthIndex}-youtube`),
        entry_id: entry.id,
        source_id: demoIncomeSources[4].id,
        amount: data.youtube,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        income_entries: { month: entry.month, deleted_at: null },
      });
    }
    if (data.sponsorships > 0) {
      amounts.push({
        id: uuid(`amount-${monthIndex}-sponsorships`),
        entry_id: entry.id,
        source_id: demoIncomeSources[5].id,
        amount: data.sponsorships,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        income_entries: { month: entry.month, deleted_at: null },
      });
    }

    return amounts;
  });

// Plain income amounts (without join)
export const demoIncomeAmountsPlain: IncomeAmount[] = demoIncomeAmounts.map(({ income_entries, ...rest }) => rest);

// ============================================
// EXPENSES (comprehensive list)
// ============================================
export const demoExpenses: Expense[] = [
  // ===== PERSONAL EXPENSES =====
  // Housing
  {
    id: uuid("expense-1"),
    name: "Rent",
    amount: 2200,
    frequency: "monthly",
    expense_type: "personal",
    category: "housing",
    is_active: true,
    effective_date: "2024-01-01",
    notes: "2BR apartment downtown",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-2"),
    name: "Renters Insurance",
    amount: 180,
    frequency: "annual",
    expense_type: "personal",
    category: "housing",
    is_active: true,
    effective_date: "2024-01-01",
    notes: null,
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  // Transport
  {
    id: uuid("expense-3"),
    name: "Car Payment",
    amount: 485,
    frequency: "monthly",
    expense_type: "personal",
    category: "transport",
    is_active: true,
    effective_date: "2023-06-01",
    notes: "Tesla Model 3 - 48 month loan",
    deleted_at: null,
    created_at: "2023-06-01T00:00:00Z",
    updated_at: "2023-06-01T00:00:00Z",
  },
  {
    id: uuid("expense-4"),
    name: "Car Insurance",
    amount: 145,
    frequency: "monthly",
    expense_type: "personal",
    category: "transport",
    is_active: true,
    effective_date: "2023-06-01",
    notes: null,
    deleted_at: null,
    created_at: "2023-06-01T00:00:00Z",
    updated_at: "2023-06-01T00:00:00Z",
  },
  {
    id: uuid("expense-5"),
    name: "Gas/Charging",
    amount: 80,
    frequency: "monthly",
    expense_type: "personal",
    category: "transport",
    is_active: true,
    effective_date: "2023-06-01",
    notes: "Mostly home charging",
    deleted_at: null,
    created_at: "2023-06-01T00:00:00Z",
    updated_at: "2023-06-01T00:00:00Z",
  },
  // Utilities
  {
    id: uuid("expense-6"),
    name: "Electric Bill",
    amount: 145,
    frequency: "monthly",
    expense_type: "personal",
    category: "utilities",
    is_active: true,
    effective_date: "2023-01-01",
    notes: "Average - varies seasonally",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-7"),
    name: "Internet",
    amount: 79.99,
    frequency: "monthly",
    expense_type: "personal",
    category: "utilities",
    is_active: true,
    effective_date: "2023-01-01",
    notes: "1Gbps fiber",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-8"),
    name: "Phone Plan",
    amount: 85,
    frequency: "monthly",
    expense_type: "personal",
    category: "utilities",
    is_active: true,
    effective_date: "2023-01-01",
    notes: "Unlimited data",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  // Health
  {
    id: uuid("expense-9"),
    name: "Health Insurance",
    amount: 420,
    frequency: "monthly",
    expense_type: "personal",
    category: "health",
    is_active: true,
    effective_date: "2024-01-01",
    notes: "Self-employed health plan",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-10"),
    name: "Gym Membership",
    amount: 89,
    frequency: "monthly",
    expense_type: "personal",
    category: "health",
    is_active: true,
    effective_date: "2023-01-01",
    notes: "Equinox",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-11"),
    name: "Dental Insurance",
    amount: 45,
    frequency: "monthly",
    expense_type: "personal",
    category: "health",
    is_active: true,
    effective_date: "2024-01-01",
    notes: null,
    deleted_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  // Subscriptions
  {
    id: uuid("expense-12"),
    name: "Spotify Family",
    amount: 16.99,
    frequency: "monthly",
    expense_type: "personal",
    category: "subscriptions",
    is_active: true,
    effective_date: "2023-01-01",
    notes: null,
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-13"),
    name: "Netflix",
    amount: 22.99,
    frequency: "monthly",
    expense_type: "personal",
    category: "entertainment",
    is_active: true,
    effective_date: "2023-01-01",
    notes: "4K plan",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-14"),
    name: "YouTube Premium",
    amount: 13.99,
    frequency: "monthly",
    expense_type: "personal",
    category: "subscriptions",
    is_active: true,
    effective_date: "2023-01-01",
    notes: null,
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-15"),
    name: "iCloud Storage",
    amount: 9.99,
    frequency: "monthly",
    expense_type: "personal",
    category: "subscriptions",
    is_active: true,
    effective_date: "2023-01-01",
    notes: "2TB plan",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-16"),
    name: "Amazon Prime",
    amount: 139,
    frequency: "annual",
    expense_type: "personal",
    category: "subscriptions",
    is_active: true,
    effective_date: "2024-03-01",
    notes: null,
    deleted_at: null,
    created_at: "2023-03-01T00:00:00Z",
    updated_at: "2024-03-01T00:00:00Z",
  },

  // ===== BUSINESS EXPENSES =====
  // Hosting
  {
    id: uuid("expense-17"),
    name: "Vercel Pro",
    amount: 20,
    frequency: "monthly",
    expense_type: "business",
    category: "hosting",
    is_active: true,
    effective_date: "2023-01-01",
    notes: "Main app hosting",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-18"),
    name: "Supabase Pro",
    amount: 25,
    frequency: "monthly",
    expense_type: "business",
    category: "hosting",
    is_active: true,
    effective_date: "2023-01-01",
    notes: "Database & auth",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-19"),
    name: "AWS",
    amount: 35,
    frequency: "monthly",
    expense_type: "business",
    category: "hosting",
    is_active: true,
    effective_date: "2023-06-01",
    notes: "S3 + CloudFront for media",
    deleted_at: null,
    created_at: "2023-06-01T00:00:00Z",
    updated_at: "2023-06-01T00:00:00Z",
  },
  {
    id: uuid("expense-20"),
    name: "Domain Renewals",
    amount: 150,
    frequency: "annual",
    expense_type: "business",
    category: "hosting",
    is_active: true,
    effective_date: "2024-01-01",
    notes: "5 domains",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  // Software
  {
    id: uuid("expense-21"),
    name: "Figma",
    amount: 15,
    frequency: "monthly",
    expense_type: "business",
    category: "software",
    is_active: true,
    effective_date: "2023-01-01",
    notes: "Professional plan",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-22"),
    name: "Claude Pro",
    amount: 20,
    frequency: "monthly",
    expense_type: "business",
    category: "software",
    is_active: true,
    effective_date: "2024-01-01",
    notes: "AI assistant",
    deleted_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-23"),
    name: "ChatGPT Plus",
    amount: 20,
    frequency: "monthly",
    expense_type: "business",
    category: "software",
    is_active: true,
    effective_date: "2023-03-01",
    notes: null,
    deleted_at: null,
    created_at: "2023-03-01T00:00:00Z",
    updated_at: "2023-03-01T00:00:00Z",
  },
  {
    id: uuid("expense-24"),
    name: "Notion",
    amount: 10,
    frequency: "monthly",
    expense_type: "business",
    category: "software",
    is_active: true,
    effective_date: "2023-01-01",
    notes: "Docs & wiki",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-25"),
    name: "Google Workspace",
    amount: 12,
    frequency: "monthly",
    expense_type: "business",
    category: "software",
    is_active: true,
    effective_date: "2023-01-01",
    notes: "Business email",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-26"),
    name: "Linear",
    amount: 10,
    frequency: "monthly",
    expense_type: "business",
    category: "software",
    is_active: true,
    effective_date: "2024-01-01",
    notes: "Project management",
    deleted_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-27"),
    name: "1Password Teams",
    amount: 7.99,
    frequency: "monthly",
    expense_type: "business",
    category: "software",
    is_active: true,
    effective_date: "2023-01-01",
    notes: "Password manager",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-28"),
    name: "Loom Pro",
    amount: 15,
    frequency: "monthly",
    expense_type: "business",
    category: "software",
    is_active: true,
    effective_date: "2024-03-01",
    notes: "Video messaging",
    deleted_at: null,
    created_at: "2024-03-01T00:00:00Z",
    updated_at: "2024-03-01T00:00:00Z",
  },
  // Marketing
  {
    id: uuid("expense-29"),
    name: "ConvertKit",
    amount: 79,
    frequency: "monthly",
    expense_type: "business",
    category: "marketing",
    is_active: true,
    effective_date: "2024-01-01",
    notes: "Email marketing - 10k subscribers",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-30"),
    name: "Buffer",
    amount: 15,
    frequency: "monthly",
    expense_type: "business",
    category: "marketing",
    is_active: true,
    effective_date: "2023-06-01",
    notes: "Social media scheduling",
    deleted_at: null,
    created_at: "2023-06-01T00:00:00Z",
    updated_at: "2023-06-01T00:00:00Z",
  },
  {
    id: uuid("expense-31"),
    name: "Fathom Analytics",
    amount: 14,
    frequency: "monthly",
    expense_type: "business",
    category: "marketing",
    is_active: true,
    effective_date: "2023-01-01",
    notes: "Privacy-focused analytics",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-01-01T00:00:00Z",
  },
  // Fees
  {
    id: uuid("expense-32"),
    name: "Stripe Fees",
    amount: 450,
    frequency: "monthly",
    expense_type: "business",
    category: "fees",
    is_active: true,
    effective_date: "2024-01-01",
    notes: "~2.9% of revenue",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-33"),
    name: "Gumroad Fees",
    amount: 120,
    frequency: "monthly",
    expense_type: "business",
    category: "fees",
    is_active: true,
    effective_date: "2023-06-01",
    notes: "Course platform fees",
    deleted_at: null,
    created_at: "2023-06-01T00:00:00Z",
    updated_at: "2023-06-01T00:00:00Z",
  },
  // Services
  {
    id: uuid("expense-34"),
    name: "Accountant",
    amount: 1500,
    frequency: "quarterly",
    expense_type: "business",
    category: "services",
    is_active: true,
    effective_date: "2024-01-01",
    notes: "Quarterly bookkeeping + tax prep",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: uuid("expense-35"),
    name: "Virtual Assistant",
    amount: 500,
    frequency: "monthly",
    expense_type: "business",
    category: "services",
    is_active: true,
    effective_date: "2024-06-01",
    notes: "10 hrs/month - admin tasks",
    deleted_at: null,
    created_at: "2024-06-01T00:00:00Z",
    updated_at: "2024-06-01T00:00:00Z",
  },
  {
    id: uuid("expense-36"),
    name: "Legal Retainer",
    amount: 300,
    frequency: "monthly",
    expense_type: "business",
    category: "services",
    is_active: true,
    effective_date: "2024-01-01",
    notes: "Contract review & legal advice",
    deleted_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  // Insurance
  {
    id: uuid("expense-37"),
    name: "Business Insurance",
    amount: 1800,
    frequency: "annual",
    expense_type: "business",
    category: "insurance",
    is_active: true,
    effective_date: "2024-01-01",
    notes: "E&O + General Liability",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  // Contractors
  {
    id: uuid("expense-38"),
    name: "Video Editor",
    amount: 800,
    frequency: "monthly",
    expense_type: "business",
    category: "contractors",
    is_active: true,
    effective_date: "2024-01-01",
    notes: "4 videos/month",
    deleted_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },

  // ===== PAUSED EXPENSES =====
  {
    id: uuid("expense-39"),
    name: "Adobe Creative Cloud",
    amount: 59.99,
    frequency: "monthly",
    expense_type: "business",
    category: "software",
    is_active: false,
    effective_date: "2023-01-01",
    notes: "Paused - using Figma instead",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2024-06-01T00:00:00Z",
  },
  {
    id: uuid("expense-40"),
    name: "Webflow",
    amount: 29,
    frequency: "monthly",
    expense_type: "business",
    category: "hosting",
    is_active: false,
    effective_date: "2023-01-01",
    notes: "Migrated to Next.js",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2024-03-01T00:00:00Z",
  },
  {
    id: uuid("expense-41"),
    name: "Mailchimp",
    amount: 35,
    frequency: "monthly",
    expense_type: "business",
    category: "marketing",
    is_active: false,
    effective_date: "2023-01-01",
    notes: "Switched to ConvertKit",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2023-12-01T00:00:00Z",
  },
  {
    id: uuid("expense-42"),
    name: "Peloton",
    amount: 44,
    frequency: "monthly",
    expense_type: "personal",
    category: "health",
    is_active: false,
    effective_date: "2023-01-01",
    notes: "Paused - prefer gym",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
    updated_at: "2024-02-01T00:00:00Z",
  },
];

// ============================================
// EXPENSE HISTORY (comprehensive)
// ============================================
export const demoExpenseHistory: ExpenseHistory[] = [
  // Rent increase
  {
    id: uuid("history-1"),
    expense_id: demoExpenses[0].id,
    event_type: "created",
    amount: "1900",
    frequency: "monthly",
    is_active: true,
    changed_at: "2023-01-01T00:00:00Z",
    notes: "Initial rent",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("history-2"),
    expense_id: demoExpenses[0].id,
    event_type: "updated",
    amount: "2000",
    frequency: "monthly",
    is_active: true,
    changed_at: "2023-07-01T00:00:00Z",
    notes: "Lease renewal - small increase",
    deleted_at: null,
    created_at: "2023-07-01T00:00:00Z",
  },
  {
    id: uuid("history-3"),
    expense_id: demoExpenses[0].id,
    event_type: "updated",
    amount: "2200",
    frequency: "monthly",
    is_active: true,
    changed_at: "2024-01-01T00:00:00Z",
    notes: "Annual rent increase",
    deleted_at: null,
    created_at: "2024-01-01T00:00:00Z",
  },
  // Health insurance changes
  {
    id: uuid("history-4"),
    expense_id: demoExpenses[8].id,
    event_type: "created",
    amount: "380",
    frequency: "monthly",
    is_active: true,
    changed_at: "2023-01-01T00:00:00Z",
    notes: null,
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("history-5"),
    expense_id: demoExpenses[8].id,
    event_type: "updated",
    amount: "420",
    frequency: "monthly",
    is_active: true,
    changed_at: "2024-01-01T00:00:00Z",
    notes: "Premium increase",
    deleted_at: null,
    created_at: "2024-01-01T00:00:00Z",
  },
  // ConvertKit growth
  {
    id: uuid("history-6"),
    expense_id: demoExpenses[28].id,
    event_type: "created",
    amount: "29",
    frequency: "monthly",
    is_active: true,
    changed_at: "2023-01-01T00:00:00Z",
    notes: "Starting plan",
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("history-7"),
    expense_id: demoExpenses[28].id,
    event_type: "updated",
    amount: "49",
    frequency: "monthly",
    is_active: true,
    changed_at: "2023-06-01T00:00:00Z",
    notes: "Upgraded - 5k subscribers",
    deleted_at: null,
    created_at: "2023-06-01T00:00:00Z",
  },
  {
    id: uuid("history-8"),
    expense_id: demoExpenses[28].id,
    event_type: "updated",
    amount: "79",
    frequency: "monthly",
    is_active: true,
    changed_at: "2024-01-01T00:00:00Z",
    notes: "Hit 10k subscribers",
    deleted_at: null,
    created_at: "2024-01-01T00:00:00Z",
  },
  // Stripe fees growth
  {
    id: uuid("history-9"),
    expense_id: demoExpenses[31].id,
    event_type: "created",
    amount: "200",
    frequency: "monthly",
    is_active: true,
    changed_at: "2023-01-01T00:00:00Z",
    notes: null,
    deleted_at: null,
    created_at: "2023-01-01T00:00:00Z",
  },
  {
    id: uuid("history-10"),
    expense_id: demoExpenses[31].id,
    event_type: "updated",
    amount: "320",
    frequency: "monthly",
    is_active: true,
    changed_at: "2023-07-01T00:00:00Z",
    notes: "Revenue growth",
    deleted_at: null,
    created_at: "2023-07-01T00:00:00Z",
  },
  {
    id: uuid("history-11"),
    expense_id: demoExpenses[31].id,
    event_type: "updated",
    amount: "450",
    frequency: "monthly",
    is_active: true,
    changed_at: "2024-01-01T00:00:00Z",
    notes: "Course launch spike",
    deleted_at: null,
    created_at: "2024-01-01T00:00:00Z",
  },
  // Paused expense
  {
    id: uuid("history-12"),
    expense_id: demoExpenses[38].id,
    event_type: "paused",
    amount: "59.99",
    frequency: "monthly",
    is_active: false,
    changed_at: "2024-06-01T00:00:00Z",
    notes: "Switching to Figma",
    deleted_at: null,
    created_at: "2024-06-01T00:00:00Z",
  },
];

// ============================================
// NET WORTH (72 months - back to 2020, showing growth)
// Shows journey from ~$15k starting freelancer to ~$157k established entrepreneur
// ============================================
export const demoNetWorth: NetWorth[] = Array.from({ length: 72 }, (_, i) => {
  // Non-linear growth: slower at first, accelerating as business grows
  // Month 71 (2020): ~$15k | Month 0 (2026): ~$157k

  const monthsFromStart = 71 - i; // 0 = start, 71 = current

  // Exponential-ish growth curve with some realism
  // Base growth accelerates over time as income increases
  let amount: number;

  if (monthsFromStart < 12) {
    // Year 1 (2020): Starting out, slow growth ~$15k -> $22k
    amount = 15000 + (monthsFromStart * 600);
  } else if (monthsFromStart < 24) {
    // Year 2 (2021): Building momentum ~$22k -> $38k
    const yearProgress = monthsFromStart - 12;
    amount = 22000 + (yearProgress * 1350);
  } else if (monthsFromStart < 36) {
    // Year 3 (2022): SaaS launch, faster growth ~$38k -> $60k
    const yearProgress = monthsFromStart - 24;
    amount = 38000 + (yearProgress * 1850);
  } else if (monthsFromStart < 48) {
    // Year 4 (2023): Scaling up ~$60k -> $90k
    const yearProgress = monthsFromStart - 36;
    amount = 60000 + (yearProgress * 2500);
  } else if (monthsFromStart < 60) {
    // Year 5 (2024): Strong growth ~$90k -> $125k
    const yearProgress = monthsFromStart - 48;
    amount = 90000 + (yearProgress * 2920);
  } else {
    // Year 6 (2025-2026): Established ~$125k -> $157k
    const yearProgress = monthsFromStart - 60;
    amount = 125000 + (yearProgress * 2700);
  }

  // Add natural variation
  const variation = Math.sin(i * 0.5) * (amount * 0.03); // 3% variation

  // Tax payment dips (Q1 each year - roughly every 12 months)
  const isQ1 = i === 3 || i === 15 || i === 27 || i === 39 || i === 51 || i === 63;
  const taxDip = isQ1 ? -(amount * 0.06) : 0; // 6% dip for taxes

  amount = amount + variation + taxDip;

  // Milestone notes
  const notes = i === 0
    ? "All-time high!"
    : i === 3 || i === 15 || i === 27 || i === 39 || i === 51 || i === 63
    ? "Quarterly tax payment"
    : i === 6
    ? "Course launch revenue boost"
    : i === 12
    ? "One year of tracking!"
    : i === 24
    ? "Two years - doubled net worth!"
    : i === 36
    ? "Three year mark - hit $60k!"
    : i === 48
    ? "Four years - SaaS really paying off"
    : i === 60
    ? "Five years - crossed $125k!"
    : i === 71
    ? "The beginning - just starting to track finances"
    : null;

  return {
    id: uuid(`nw-${i}`),
    date: getDate(i * 30),
    amount: Math.round(amount),
    notes,
    deleted_at: null,
    created_at: getDate(i * 30) + "T00:00:00Z",
    updated_at: getDate(i * 30) + "T00:00:00Z",
  };
});

// ============================================
// AUTOMATIONS (comprehensive)
// ============================================
export const demoAutomations: AutomationWithActions[] = [
  {
    id: uuid("automation-1"),
    user_id: uuid("user"),
    name: "Monthly Income Reminder",
    description: "Reminds you to log your income at the start of each month",
    is_active: true,
    trigger_type: "schedule",
    trigger_config: {
      frequency: "monthly",
      time: "09:00",
      timezone: "America/New_York",
      day_of_month: 1,
      duration_type: "forever",
    },
    last_run_at: getDateTime(1, 9),
    next_run_at: getMonth(-1) + "T09:00:00Z",
    deleted_at: null,
    created_at: "2023-06-01T00:00:00Z",
    updated_at: "2023-06-01T00:00:00Z",
    automation_actions: [
      {
        id: uuid("action-1"),
        automation_id: uuid("automation-1"),
        action_type: "notification",
        action_config: {
          title: "Time to log income!",
          message: "It's the start of a new month. Don't forget to record last month's income.",
          link: "/income/new",
        },
        sort_order: 0,
        created_at: "2023-06-01T00:00:00Z",
      },
    ],
  },
  {
    id: uuid("automation-2"),
    user_id: uuid("user"),
    name: "Quarterly Net Worth Update",
    description: "Reminder to update your net worth every quarter for tracking long-term progress",
    is_active: true,
    trigger_type: "schedule",
    trigger_config: {
      frequency: "quarterly",
      time: "10:00",
      timezone: "America/New_York",
      day_of_month: 1,
      months: [1, 4, 7, 10],
      duration_type: "forever",
    },
    last_run_at: getDateTime(45, 10),
    next_run_at: null,
    deleted_at: null,
    created_at: "2023-06-01T00:00:00Z",
    updated_at: "2023-06-01T00:00:00Z",
    automation_actions: [
      {
        id: uuid("action-2a"),
        automation_id: uuid("automation-2"),
        action_type: "notification",
        action_config: {
          title: "Quarterly Net Worth Check-in",
          message: "Time to update your net worth! Track your financial progress.",
          link: "/net-worth/new",
        },
        sort_order: 0,
        created_at: "2023-06-01T00:00:00Z",
      },
      {
        id: uuid("action-2b"),
        automation_id: uuid("automation-2"),
        action_type: "email",
        action_config: {
          to: "demo@example.com",
          subject: "Quarterly Net Worth Check-in",
          body: "Hi there,\n\nIt's time for your quarterly net worth update. Log in to record your current financial position and track your progress.\n\nBest,\nYour Finance App",
          format: "text",
        },
        sort_order: 1,
        created_at: "2023-06-01T00:00:00Z",
      },
    ],
  },
  {
    id: uuid("automation-3"),
    user_id: uuid("user"),
    name: "Weekly Expense Review",
    description: "Weekly reminder to review and update any changing expenses",
    is_active: true,
    trigger_type: "schedule",
    trigger_config: {
      frequency: "weekly",
      time: "18:00",
      timezone: "America/New_York",
      day_of_week: 5, // Friday
      duration_type: "forever",
    },
    last_run_at: getDateTime(2, 18),
    next_run_at: null,
    deleted_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    automation_actions: [
      {
        id: uuid("action-3"),
        automation_id: uuid("automation-3"),
        action_type: "notification",
        action_config: {
          title: "Weekly Expense Review",
          message: "End of week! Take a moment to review your expenses.",
          link: "/expenses",
        },
        sort_order: 0,
        created_at: "2024-01-01T00:00:00Z",
      },
    ],
  },
  {
    id: uuid("automation-4"),
    user_id: uuid("user"),
    name: "Tax Preparation Reminder",
    description: "Annual reminder to prepare tax documents",
    is_active: true,
    trigger_type: "schedule",
    trigger_config: {
      frequency: "yearly",
      time: "09:00",
      timezone: "America/New_York",
      month: 2, // February
      day_of_month: 1,
      duration_type: "forever",
    },
    last_run_at: "2024-02-01T09:00:00Z",
    next_run_at: "2025-02-01T09:00:00Z",
    deleted_at: null,
    created_at: "2024-01-15T00:00:00Z",
    updated_at: "2024-01-15T00:00:00Z",
    automation_actions: [
      {
        id: uuid("action-4"),
        automation_id: uuid("automation-4"),
        action_type: "email",
        action_config: {
          to: "demo@example.com",
          subject: "Time to Prepare Your Taxes!",
          body: "Hi there,\n\nIt's February - time to start gathering your tax documents!\n\nHere's what you'll need:\n- All income records from the app\n- Business expense reports\n- 1099s from clients\n- Bank statements\n\nLog in to export your data.\n\nBest,\nYour Finance App",
          format: "text",
        },
        sort_order: 0,
        created_at: "2024-01-15T00:00:00Z",
      },
    ],
  },
  {
    id: uuid("automation-5"),
    user_id: uuid("user"),
    name: "Manual Data Export",
    description: "Manually trigger a full data export to CSV",
    is_active: true,
    trigger_type: "manual",
    trigger_config: {},
    last_run_at: getDateTime(14, 15),
    next_run_at: null,
    deleted_at: null,
    created_at: "2024-03-01T00:00:00Z",
    updated_at: "2024-03-01T00:00:00Z",
    automation_actions: [
      {
        id: uuid("action-5"),
        automation_id: uuid("automation-5"),
        action_type: "email",
        action_config: {
          to: "demo@example.com",
          subject: "Your Data Export is Ready",
          body: "Your requested data export has been generated and is attached to this email.",
          format: "text",
        },
        sort_order: 0,
        created_at: "2024-03-01T00:00:00Z",
      },
    ],
  },
  // Inactive automation
  {
    id: uuid("automation-6"),
    user_id: uuid("user"),
    name: "Daily Summary (Paused)",
    description: "Daily email summary of financial activity - currently paused",
    is_active: false,
    trigger_type: "schedule",
    trigger_config: {
      frequency: "daily",
      time: "20:00",
      timezone: "America/New_York",
      duration_type: "forever",
    },
    last_run_at: "2024-06-15T20:00:00Z",
    next_run_at: null,
    deleted_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-06-15T00:00:00Z",
    automation_actions: [
      {
        id: uuid("action-6"),
        automation_id: uuid("automation-6"),
        action_type: "email",
        action_config: {
          to: "demo@example.com",
          subject: "Daily Financial Summary",
          body: "Here's your daily summary of financial activity...",
          format: "text",
        },
        sort_order: 0,
        created_at: "2024-01-01T00:00:00Z",
      },
    ],
  },
];

// ============================================
// AUTOMATION RUNS
// ============================================
export const demoAutomationRuns: AutomationRun[] = [
  // Recent runs for Monthly Income Reminder
  {
    id: uuid("run-1"),
    automation_id: uuid("automation-1"),
    status: "success",
    started_at: getDateTime(1, 9),
    completed_at: getDateTime(1, 9),
    error: null,
  },
  {
    id: uuid("run-2"),
    automation_id: uuid("automation-1"),
    status: "success",
    started_at: getDateTime(31, 9),
    completed_at: getDateTime(31, 9),
    error: null,
  },
  {
    id: uuid("run-3"),
    automation_id: uuid("automation-1"),
    status: "success",
    started_at: getDateTime(62, 9),
    completed_at: getDateTime(62, 9),
    error: null,
  },
  // Quarterly runs
  {
    id: uuid("run-4"),
    automation_id: uuid("automation-2"),
    status: "success",
    started_at: getDateTime(45, 10),
    completed_at: getDateTime(45, 10),
    error: null,
  },
  {
    id: uuid("run-5"),
    automation_id: uuid("automation-2"),
    status: "success",
    started_at: getDateTime(135, 10),
    completed_at: getDateTime(135, 10),
    error: null,
  },
  // Weekly runs
  {
    id: uuid("run-6"),
    automation_id: uuid("automation-3"),
    status: "success",
    started_at: getDateTime(2, 18),
    completed_at: getDateTime(2, 18),
    error: null,
  },
  {
    id: uuid("run-7"),
    automation_id: uuid("automation-3"),
    status: "success",
    started_at: getDateTime(9, 18),
    completed_at: getDateTime(9, 18),
    error: null,
  },
  {
    id: uuid("run-8"),
    automation_id: uuid("automation-3"),
    status: "failed",
    started_at: getDateTime(16, 18),
    completed_at: getDateTime(16, 18),
    error: "Email delivery failed: recipient server timeout",
  },
  // Manual export
  {
    id: uuid("run-9"),
    automation_id: uuid("automation-5"),
    status: "success",
    started_at: getDateTime(14, 15),
    completed_at: getDateTime(14, 15),
    error: null,
  },
  // Tax reminder
  {
    id: uuid("run-10"),
    automation_id: uuid("automation-4"),
    status: "success",
    started_at: "2024-02-01T09:00:00Z",
    completed_at: "2024-02-01T09:00:15Z",
    error: null,
  },
];

// ============================================
// NOTIFICATIONS (comprehensive)
// ============================================
export const demoNotifications: Notification[] = [
  {
    id: uuid("notif-1"),
    user_id: uuid("user"),
    title: "Time to log income!",
    message: "It's the start of a new month. Don't forget to record last month's income.",
    link: "/income/new",
    is_read: false,
    automation_run_id: uuid("run-1"),
    created_at: getDateTime(1, 9),
  },
  {
    id: uuid("notif-2"),
    user_id: uuid("user"),
    title: "Weekly Expense Review",
    message: "End of week! Take a moment to review your expenses.",
    link: "/expenses",
    is_read: false,
    automation_run_id: uuid("run-6"),
    created_at: getDateTime(2, 18),
  },
  {
    id: uuid("notif-3"),
    user_id: uuid("user"),
    title: "Net worth milestone!",
    message: "Congratulations! Your net worth has crossed $150,000!",
    link: "/net-worth",
    is_read: true,
    automation_run_id: null,
    created_at: getDateTime(5, 12),
  },
  {
    id: uuid("notif-4"),
    user_id: uuid("user"),
    title: "Weekly Expense Review",
    message: "End of week! Take a moment to review your expenses.",
    link: "/expenses",
    is_read: true,
    automation_run_id: uuid("run-7"),
    created_at: getDateTime(9, 18),
  },
  {
    id: uuid("notif-5"),
    user_id: uuid("user"),
    title: "Automation failed",
    message: "Weekly Expense Review automation failed: Email delivery failed",
    link: "/automations/" + uuid("automation-3"),
    is_read: true,
    automation_run_id: uuid("run-8"),
    created_at: getDateTime(16, 18),
  },
  {
    id: uuid("notif-6"),
    user_id: uuid("user"),
    title: "Data export ready",
    message: "Your data export has been generated and sent to your email.",
    link: null,
    is_read: true,
    automation_run_id: uuid("run-9"),
    created_at: getDateTime(14, 15),
  },
  {
    id: uuid("notif-7"),
    user_id: uuid("user"),
    title: "Time to log income!",
    message: "It's the start of a new month. Don't forget to record last month's income.",
    link: "/income/new",
    is_read: true,
    automation_run_id: uuid("run-2"),
    created_at: getDateTime(31, 9),
  },
  {
    id: uuid("notif-8"),
    user_id: uuid("user"),
    title: "Quarterly Net Worth Check-in",
    message: "Time to update your net worth! Track your financial progress.",
    link: "/net-worth/new",
    is_read: true,
    automation_run_id: uuid("run-4"),
    created_at: getDateTime(45, 10),
  },
  {
    id: uuid("notif-9"),
    user_id: uuid("user"),
    title: "Welcome to the Demo!",
    message: "This is sample data to help you explore the app. Feel free to click around and explore all the features!",
    link: null,
    is_read: true,
    automation_run_id: null,
    created_at: getDateTime(60, 12),
  },
];

// ============================================
// DELETED ITEMS (for Trash)
// ============================================
export const demoDeletedSources = [
  {
    id: uuid("deleted-source-1"),
    name: "Contract Work",
    deleted_at: getDateTime(30, 14),
  },
  {
    id: uuid("deleted-source-2"),
    name: "Etsy Sales",
    deleted_at: getDateTime(90, 10),
  },
];

export const demoDeletedEntries = [
  {
    id: uuid("deleted-entry-1"),
    month: getMonth(14),
    deleted_at: getDateTime(45, 11),
  },
];

export const demoDeletedExpenses = [
  {
    id: uuid("deleted-expense-1"),
    name: "Hulu",
    deleted_at: getDateTime(60, 16),
  },
  {
    id: uuid("deleted-expense-2"),
    name: "HBO Max",
    deleted_at: getDateTime(45, 9),
  },
  {
    id: uuid("deleted-expense-3"),
    name: "Dropbox",
    deleted_at: getDateTime(120, 11),
  },
];

export const demoDeletedNetWorth = [
  {
    id: uuid("deleted-nw-1"),
    date: getDate(400),
    deleted_at: getDateTime(380, 14),
  },
];

export const demoDeletedAutomations = [
  {
    id: uuid("deleted-automation-1"),
    name: "Bi-weekly Check-in",
    deleted_at: getDateTime(90, 15),
  },
];

export const demoDeletedExpenseHistory: {
  id: string;
  event_type: string;
  amount: string;
  frequency: string;
  changed_at: string;
  deleted_at: string;
}[] = [];

// ============================================
// HELPER FUNCTIONS FOR DETAIL PAGES
// ============================================

/**
 * Get an income entry by ID with its amounts and sources
 */
export function getDemoIncomeEntry(id: string) {
  const entry = demoIncomeEntries.find((e) => e.id === id);
  if (!entry) return null;

  const amounts = demoIncomeAmountsPlain
    .filter((a) => a.entry_id === id)
    .map((amount) => {
      const source = demoIncomeSources.find((s) => s.id === amount.source_id);
      return {
        ...amount,
        income_sources: source
          ? { id: source.id, name: source.name, color: source.color }
          : null,
      };
    });

  return {
    ...entry,
    income_amounts: amounts,
  };
}

/**
 * Get adjacent income entry IDs for navigation
 */
export function getDemoAdjacentIncomeEntries(currentMonth: string) {
  const sortedEntries = [...demoIncomeEntries].sort(
    (a, b) => b.month.localeCompare(a.month)
  );
  const currentIndex = sortedEntries.findIndex((e) => e.month === currentMonth);

  return {
    prevEntryId: currentIndex < sortedEntries.length - 1 ? sortedEntries[currentIndex + 1].id : null,
    nextEntryId: currentIndex > 0 ? sortedEntries[currentIndex - 1].id : null,
  };
}

/**
 * Get an expense by ID
 */
export function getDemoExpense(id: string) {
  return demoExpenses.find((e) => e.id === id) || null;
}

/**
 * Get expense history for an expense ID
 */
export function getDemoExpenseHistory(expenseId: string) {
  return demoExpenseHistory.filter((h) => h.expense_id === expenseId);
}

/**
 * Get a net worth entry by ID
 */
export function getDemoNetWorthEntry(id: string) {
  return demoNetWorth.find((e) => e.id === id) || null;
}

/**
 * Get adjacent net worth entry IDs for navigation
 */
export function getDemoAdjacentNetWorthEntries(currentDate: string) {
  const sortedEntries = [...demoNetWorth].sort(
    (a, b) => b.date.localeCompare(a.date)
  );
  const currentIndex = sortedEntries.findIndex((e) => e.date === currentDate);

  return {
    prevEntryId: currentIndex < sortedEntries.length - 1 ? sortedEntries[currentIndex + 1].id : null,
    nextEntryId: currentIndex > 0 ? sortedEntries[currentIndex - 1].id : null,
  };
}

/**
 * Get an automation by ID with runs
 */
export function getDemoAutomation(id: string) {
  const automation = demoAutomations.find((a) => a.id === id);
  if (!automation) return null;

  const runs = demoAutomationRuns
    .filter((r) => r.automation_id === id)
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

  return {
    ...automation,
    automation_runs: runs,
  };
}

/**
 * Get notifications with optional filtering
 */
export function getDemoNotifications(options?: { unreadOnly?: boolean; limit?: number }) {
  let notifications = [...demoNotifications].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  if (options?.unreadOnly) {
    notifications = notifications.filter((n) => !n.is_read);
  }

  if (options?.limit) {
    notifications = notifications.slice(0, options.limit);
  }

  return notifications;
}

/**
 * Get unread notification count
 */
export function getDemoUnreadCount() {
  return demoNotifications.filter((n) => !n.is_read).length;
}
