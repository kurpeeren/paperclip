import { describe, expect, it } from "vitest";
import {
  budgetPolicyTitle,
  compactTokens,
  formatBudgetUsageLine,
  parseBudgetAmountInput,
  tokenAmountHint,
} from "./budget-format";

describe("budget-format", () => {
  it("compacts token counts without a redundant .0", () => {
    expect(compactTokens(20_000_000)).toBe("20M");
    expect(compactTokens(12_400_000)).toBe("12.4M");
    expect(compactTokens(5_000_000_000)).toBe("5B");
    expect(compactTokens(950)).toBe("950");
  });

  it("renders the current-window usage line per metric", () => {
    expect(
      formatBudgetUsageLine({
        metric: "tokens",
        windowKind: "calendar_day_utc",
        observedAmount: 12_400_000,
        amount: 20_000_000,
        utilizationPercent: 62,
      }),
    ).toBe("Today: 12.4M / 20M tokens (62%)");
    expect(
      formatBudgetUsageLine({ metric: "billed_cents", windowKind: "calendar_month_utc", observedAmount: 1200, amount: 10_000 }),
    ).toBe("This month: $12.00 / $100.00 (12%)");
    expect(
      formatBudgetUsageLine({ metric: "tokens", windowKind: "lifetime", observedAmount: 500, amount: 0 }),
    ).toBe("Lifetime: 500 / no limit tokens");
  });

  it("labels policies by window and metric", () => {
    expect(budgetPolicyTitle("tokens", "calendar_day_utc")).toBe("Daily (UTC) token budget");
    expect(budgetPolicyTitle("billed_cents", "calendar_month_utc")).toBe("Monthly (UTC) budget");
    expect(budgetPolicyTitle("billed_cents", "lifetime")).toBe("Lifetime budget");
  });

  it("parses token amounts as plain integers with optional separators and suffixes", () => {
    expect(parseBudgetAmountInput("tokens", "20000000")).toBe(20_000_000);
    expect(parseBudgetAmountInput("tokens", "5,000,000")).toBe(5_000_000);
    expect(parseBudgetAmountInput("tokens", "20m")).toBe(20_000_000);
    expect(parseBudgetAmountInput("tokens", "1.5B")).toBe(1_500_000_000);
    expect(parseBudgetAmountInput("tokens", "10000000000")).toBe(10_000_000_000);
    expect(parseBudgetAmountInput("tokens", "")).toBe(0);
    expect(parseBudgetAmountInput("tokens", "-5")).toBeNull();
    expect(parseBudgetAmountInput("tokens", "abc")).toBeNull();
  });

  it("parses dollar amounts into cents", () => {
    expect(parseBudgetAmountInput("billed_cents", "12.34")).toBe(1234);
    expect(parseBudgetAmountInput("billed_cents", "x")).toBeNull();
  });

  it("hints the human-readable size of a token amount", () => {
    expect(tokenAmountHint(5_000_000)).toBe("5,000,000 = 5M");
    expect(tokenAmountHint(null)).toContain("20000000 = 20M");
  });
});
