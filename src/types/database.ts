/**
 * Database types for Supabase
 * These types match our schema.sql definitions
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// Action config types for automations
export interface EmailActionConfig {
  to: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject: string;
  body: string;
  format?: "text" | "html";
}

export interface NotificationActionConfig {
  title: string;
  message: string;
  link?: string;
}

// Schedule trigger configuration
export interface ScheduleTriggerConfig {
  frequency: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
  time: string;
  timezone: string;
  // For weekly frequency
  day_of_week?: number; // 0-6 (Sunday-Saturday)
  // For monthly/quarterly/yearly frequency
  day_of_month?: number; // 1-28
  // For quarterly frequency
  months?: number[]; // e.g., [1, 4, 7, 10] for Jan, Apr, Jul, Oct
  // For yearly frequency
  month?: number; // 1-12
  // Duration settings
  duration_type: "forever" | "count" | "until";
  run_count?: number; // For "count" duration
  run_until?: string; // ISO date string for "until" duration
  runs_completed?: number; // Track completed runs for "count" duration
}

// Manual trigger has no configuration
export interface ManualTriggerConfig {
  // Empty - manual triggers have no configuration
}

// Union type for all trigger configs
export type TriggerConfig = ScheduleTriggerConfig | ManualTriggerConfig;

// Expense category types
export type ExpenseCategory =
  | "housing"
  | "transport"
  | "utilities"
  | "health"
  | "entertainment"
  | "subscriptions"
  | "software"
  | "hosting"
  | "marketing"
  | "fees"
  | "services"
  | "contractors"
  | "payroll"
  | "insurance"
  | "other";

// Expense category labels for UI display
export const EXPENSE_CATEGORIES: Record<ExpenseCategory, string> = {
  housing: "Housing",
  transport: "Transport",
  utilities: "Utilities",
  health: "Health",
  entertainment: "Entertainment",
  subscriptions: "Subscriptions",
  software: "Software",
  hosting: "Hosting",
  marketing: "Marketing",
  fees: "Fees",
  services: "Services",
  contractors: "Contractors",
  payroll: "Payroll",
  insurance: "Insurance",
  other: "Other",
};

export type Database = {
  public: {
    Tables: {
      income_sources: {
        Row: {
          id: string;
          name: string;
          slug: string;
          color: string;
          sort_order: number;
          is_active: boolean;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          color?: string;
          sort_order?: number;
          is_active?: boolean;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          color?: string;
          sort_order?: number;
          is_active?: boolean;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      income_entries: {
        Row: {
          id: string;
          month: string;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          month: string;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          month?: string;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      income_amounts: {
        Row: {
          id: string;
          entry_id: string;
          source_id: string;
          amount: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          entry_id: string;
          source_id: string;
          amount?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          entry_id?: string;
          source_id?: string;
          amount?: number;
          created_at?: string;
          updated_at?: string;
        };
      };
      expenses: {
        Row: {
          id: string;
          name: string;
          amount: number;
          frequency: "weekly" | "monthly" | "quarterly" | "annual";
          expense_type: "personal" | "business";
          category: ExpenseCategory | null;
          is_active: boolean;
          effective_date: string;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          amount: number;
          frequency?: "weekly" | "monthly" | "quarterly" | "annual";
          expense_type: "personal" | "business";
          category?: ExpenseCategory | null;
          is_active?: boolean;
          effective_date?: string;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          amount?: number;
          frequency?: "weekly" | "monthly" | "quarterly" | "annual";
          expense_type?: "personal" | "business";
          category?: ExpenseCategory | null;
          is_active?: boolean;
          effective_date?: string;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      expense_history: {
        Row: {
          id: string;
          expense_id: string;
          event_type: "created" | "updated" | "paused" | "activated" | "deleted";
          amount: string;
          frequency: string;
          is_active: boolean;
          changed_at: string;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          expense_id: string;
          event_type: "created" | "updated" | "paused" | "activated" | "deleted";
          amount: number;
          frequency: string;
          is_active: boolean;
          changed_at?: string;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          expense_id?: string;
          event_type?: "created" | "updated" | "paused" | "activated" | "deleted";
          amount?: number;
          frequency?: string;
          is_active?: boolean;
          changed_at?: string;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
        };
      };
      net_worth: {
        Row: {
          id: string;
          date: string;
          amount: number;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          date: string;
          amount: number;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          date?: string;
          amount?: number;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      automations: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          description: string | null;
          is_active: boolean;
          trigger_type: "schedule" | "manual";
          trigger_config: TriggerConfig;
          last_run_at: string | null;
          next_run_at: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          description?: string | null;
          is_active?: boolean;
          trigger_type?: "schedule" | "manual";
          trigger_config: TriggerConfig;
          last_run_at?: string | null;
          next_run_at?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          description?: string | null;
          is_active?: boolean;
          trigger_type?: "schedule" | "manual";
          trigger_config?: TriggerConfig;
          last_run_at?: string | null;
          next_run_at?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      automation_actions: {
        Row: {
          id: string;
          automation_id: string;
          action_type: "email" | "notification";
          action_config: EmailActionConfig | NotificationActionConfig;
          sort_order: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          automation_id: string;
          action_type: "email" | "notification";
          action_config: EmailActionConfig | NotificationActionConfig;
          sort_order?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          automation_id?: string;
          action_type?: "email" | "notification";
          action_config?: EmailActionConfig | NotificationActionConfig;
          sort_order?: number;
          created_at?: string;
        };
      };
      automation_runs: {
        Row: {
          id: string;
          automation_id: string;
          status: "running" | "success" | "failed";
          started_at: string;
          completed_at: string | null;
          error: string | null;
        };
        Insert: {
          id?: string;
          automation_id: string;
          status?: "running" | "success" | "failed";
          started_at?: string;
          completed_at?: string | null;
          error?: string | null;
        };
        Update: {
          id?: string;
          automation_id?: string;
          status?: "running" | "success" | "failed";
          started_at?: string;
          completed_at?: string | null;
          error?: string | null;
        };
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          message: string | null;
          link: string | null;
          is_read: boolean;
          automation_run_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title: string;
          message?: string | null;
          link?: string | null;
          is_read?: boolean;
          automation_run_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          title?: string;
          message?: string | null;
          link?: string | null;
          is_read?: boolean;
          automation_run_id?: string | null;
          created_at?: string;
        };
      };
    };
    Views: {
      income_entries_with_totals: {
        Row: {
          id: string;
          month: string;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
          total: number;
        };
      };
      expenses_with_monthly: {
        Row: {
          id: string;
          name: string;
          amount: number;
          frequency: string;
          expense_type: string;
          category: string | null;
          is_active: boolean;
          effective_date: string;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
          monthly_equivalent: number;
        };
      };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
};

// Convenience types
export type IncomeSource = Database["public"]["Tables"]["income_sources"]["Row"];
export type IncomeEntry = Database["public"]["Tables"]["income_entries"]["Row"];
export type IncomeAmount = Database["public"]["Tables"]["income_amounts"]["Row"];
export type Expense = Database["public"]["Tables"]["expenses"]["Row"];
export type ExpenseHistory = Database["public"]["Tables"]["expense_history"]["Row"];
export type NetWorth = Database["public"]["Tables"]["net_worth"]["Row"];

// Extended types with joins
export type IncomeEntryWithAmounts = IncomeEntry & {
  income_amounts: (IncomeAmount & {
    income_sources: IncomeSource;
  })[];
  total: number;
};

export type ExpenseWithHistory = Expense & {
  expense_history: ExpenseHistory[];
  monthly_equivalent: number;
};

// Automation types
export type Automation = Database["public"]["Tables"]["automations"]["Row"];
export type AutomationInsert = Database["public"]["Tables"]["automations"]["Insert"];
export type AutomationAction = Database["public"]["Tables"]["automation_actions"]["Row"];
export type AutomationActionInsert = Database["public"]["Tables"]["automation_actions"]["Insert"];
export type AutomationRun = Database["public"]["Tables"]["automation_runs"]["Row"];
export type Notification = Database["public"]["Tables"]["notifications"]["Row"];

// Extended automation types with joins
export type AutomationWithActions = Automation & {
  automation_actions: AutomationAction[];
  automation_runs?: { id: string }[];
};

export type AutomationWithRuns = Automation & {
  automation_runs: AutomationRun[];
};

export type AutomationFull = Automation & {
  automation_actions: AutomationAction[];
  automation_runs: AutomationRun[];
};
