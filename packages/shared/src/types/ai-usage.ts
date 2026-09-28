import type { AiUsageModelFamily, AiUsagePeriod } from "../ai-usage.js";

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

export type AiSubscriptionUsage =
  | {
      available: true;
      provider: "anthropic";
      windows: AiSubscriptionUsageWindow[];
      /** iso timestamp of the upstream fetch (cached responses keep the original) */
      fetchedAt: string;
    }
  | {
      available: false;
      provider: "anthropic";
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

export interface AiUsagePeriodSummary {
  period: AiUsagePeriod;
  label: string;
  from: string;
  to: string;
  /** elapsed hours in the period used for the burn rate (>= 1) */
  elapsedHours: number;
  families: AiUsageFamilyTotals[];
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
