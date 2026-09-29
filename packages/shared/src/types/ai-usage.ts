import type { AiUsageModelFamily, AiUsagePeriod } from "../ai-usage.js";
import type { BudgetWindowKind } from "../constants.js";

/** One rate-limit window from the provider's subscription usage API. */
export interface AiSubscriptionUsageWindow {
  /** provider window key, e.g. "five_hour", "seven_day", "seven_day_opus" */
  key: string;
  /** human label, e.g. "5-hour window" */
  label: string;
  /** percent of the window already consumed (0-100) */
  utilization: number;
  /** iso timestamp when this window resets, null when not reported */
  resetsAt: string | null;
}

/** Subscription providers whose quota windows the dashboard can render. */
export type AiSubscriptionProvider = "anthropic" | "antigravity";

export type AiSubscriptionUsage =
  | {
      available: true;
      provider: AiSubscriptionProvider;
      windows: AiSubscriptionUsageWindow[];
      /** iso timestamp of the upstream fetch (cached responses keep the original) */
      fetchedAt: string;
      /** true when the upstream refresh failed and these windows are the last successful fetch */
      stale?: boolean;
      /** why the last refresh failed (only set when stale); never contains credential material */
      staleReason?: string;
    }
  | {
      available: false;
      provider: AiSubscriptionProvider;
      /** human-readable reason; never contains credential material */
      reason: string;
    };

/** Token and cost totals for one model family inside one period. */
export interface AiUsageFamilyTotals {
  family: AiUsageModelFamily;
  label: string;
  /** null when no adapter in this bucket reported token counts */
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costCents: number;
  runCount: number;
  eventCount: number;
  /** estimated burn rate over the elapsed part of the period */
  costCentsPerHour: number;
  tokensPerHour: number | null;
}

/**
 * The active `tokens` budget policy of an agent, evaluated over the policy's
 * own current window (not the dashboard period), so the panel can show
 * "used / daily limit" next to the period totals.
 */
export interface AiUsageAgentTokenBudget {
  policyId: string;
  windowKind: BudgetWindowKind;
  /** human label of the window, e.g. "Daily (UTC)" */
  windowLabel: string;
  windowStart: string;
  windowEnd: string;
  /** token limit of the policy */
  limit: number;
  /** tokens observed inside the policy window */
  observed: number;
  /** observed / limit, in percent, not clamped (>100 when over) */
  utilizationPercent: number;
  hardStopEnabled: boolean;
}

/** Token totals for one agent inside one period. */
export interface AiUsageAgentTotals {
  agentId: string;
  name: string;
  /** resolved avatar: uploaded image when set, otherwise the generated character */
  avatarUrl: string | null;
  runCount: number;
  eventCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** null when the agent has no active `tokens` budget policy */
  tokenBudget: AiUsageAgentTokenBudget | null;
}

export interface AiUsagePeriodSummary {
  period: AiUsagePeriod;
  label: string;
  from: string;
  to: string;
  /** elapsed hours in the period used for the burn rate (>= 1) */
  elapsedHours: number;
  families: AiUsageFamilyTotals[];
  /** per-agent token totals for the period, sorted by total tokens desc */
  byAgent: AiUsageAgentTotals[];
  totals: {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    costCents: number;
    runCount: number;
    costCentsPerHour: number;
    tokensPerHour: number | null;
  };
}

export interface AiUsageSummary {
  companyId: string;
  generatedAt: string;
  periods: AiUsagePeriodSummary[];
}
