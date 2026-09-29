import {
  BUDGET_METRIC_LABELS,
  BUDGET_WINDOW_KIND_LABELS,
  type BudgetMetric,
  type BudgetWindowKind,
} from "@paperclipai/shared";
import { formatCents, formatTokens } from "./utils";

/** `formatTokens` without a redundant `.0`: 20,000,000 -> "20M", 12,400,000 -> "12.4M". */
export function compactTokens(value: number): string {
  return formatTokens(value).replace(/\.0([kMB])$/, "$1");
}

/** Amount in the metric's own unit without a unit word: "$1.50" or "12.4M". */
export function formatBudgetAmountShort(metric: BudgetMetric, value: number): string {
  return metric === "tokens" ? compactTokens(value) : formatCents(value);
}

/** Amount with its unit: "$1.50" or "12.4M tokens". */
export function formatBudgetAmount(metric: BudgetMetric, value: number): string {
  return metric === "tokens" ? `${compactTokens(value)} tokens` : formatCents(value);
}

export function budgetMetricLabel(metric: BudgetMetric): string {
  return BUDGET_METRIC_LABELS[metric];
}

export function budgetWindowLabel(windowKind: BudgetWindowKind): string {
  return BUDGET_WINDOW_KIND_LABELS[windowKind];
}

/** "Daily (UTC) token budget", "Monthly (UTC) budget", "Lifetime budget". */
export function budgetPolicyTitle(metric: BudgetMetric, windowKind: BudgetWindowKind): string {
  return `${budgetWindowLabel(windowKind)} ${metric === "tokens" ? "token " : ""}budget`;
}

/** The word for the current window: "Today", "This month", "Lifetime". */
export function budgetPeriodWord(windowKind: BudgetWindowKind): string {
  switch (windowKind) {
    case "calendar_day_utc":
      return "Today";
    case "calendar_month_utc":
      return "This month";
    default:
      return "Lifetime";
  }
}

/**
 * One-line usage summary for a policy:
 * "Today: 12.4M / 20M tokens (62%)" or "This month: $12.00 / $100.00 (12%)".
 */
export function formatBudgetUsageLine(input: {
  metric: BudgetMetric;
  windowKind: BudgetWindowKind;
  observedAmount: number;
  amount: number;
  utilizationPercent?: number;
}): string {
  const hasLimit = input.amount > 0;
  const percent = hasLimit
    ? Math.round(input.utilizationPercent ?? (input.observedAmount / input.amount) * 100)
    : null;
  const observed = formatBudgetAmountShort(input.metric, input.observedAmount);
  const limit = hasLimit ? formatBudgetAmountShort(input.metric, input.amount) : "no limit";
  const unit = input.metric === "tokens" ? " tokens" : "";
  return `${budgetPeriodWord(input.windowKind)}: ${observed} / ${limit}${unit}${percent == null ? "" : ` (${percent}%)`}`;
}

/** Hint under a token amount input: "5,000,000 = 5M". */
export function tokenAmountHint(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return "Plain number of tokens, e.g. 20000000 = 20M (k/M/B suffixes work too)";
  }
  return `${value.toLocaleString("en-US")} = ${compactTokens(value)}`;
}

/**
 * Parse an amount typed for a metric into integer metric units (cents or
 * tokens). Tokens accept plain digits, thousands separators and k/M/B
 * suffixes ("20m" = 20,000,000). Returns null when the input is invalid.
 */
export function parseBudgetAmountInput(metric: BudgetMetric, raw: string): number | null {
  const normalized = raw.trim().replace(/[,_\s]/g, "");
  if (normalized.length === 0) return 0;
  if (metric === "tokens") {
    const match = normalized.match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
    if (!match) return null;
    const suffix = match[2]?.toLowerCase();
    const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
    const value = Math.round(Number(match[1]) * multiplier);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

/** The text an amount input should show for a stored value. */
export function budgetAmountInputValue(metric: BudgetMetric, value: number): string {
  return metric === "tokens" ? String(value) : (value / 100).toFixed(2);
}

export function budgetAmountInvalidMessage(metric: BudgetMetric): string {
  return metric === "tokens"
    ? "Enter a valid non-negative whole number of tokens."
    : "Enter a valid non-negative dollar amount.";
}
