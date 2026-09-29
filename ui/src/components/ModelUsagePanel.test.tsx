// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSubscriptionUsage, AiUsageSummary } from "@paperclipai/shared";
import { ModelUsagePanel, formatResetsIn, usageTone } from "./ModelUsagePanel";

const mockAiUsageApi = vi.hoisted(() => ({
  subscription: vi.fn(),
  summary: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../api/ai-usage", () => ({
  aiUsageApi: mockAiUsageApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const NOW = Date.parse("2026-09-28T12:00:00Z");

const availableUsage: AiSubscriptionUsage = {
  available: true,
  provider: "anthropic",
  fetchedAt: "2026-09-28T12:00:00.000Z",
  windows: [
    { key: "five_hour", label: "5-hour window", utilization: 96, resetsAt: "2026-09-28T14:59:59Z" },
    { key: "seven_day", label: "7-day window (all models)", utilization: 26, resetsAt: "2026-09-30T14:00:00Z" },
    { key: "seven_day_sonnet", label: "7-day window (Sonnet)", utilization: 72.5, resetsAt: null },
  ],
};

const summary: AiUsageSummary = {
  companyId: "company-1",
  generatedAt: "2026-09-28T12:00:00.000Z",
  periods: [
    {
      period: "today",
      label: "Today",
      from: "2026-09-28T00:00:00.000Z",
      to: "2026-09-28T12:00:00.000Z",
      elapsedHours: 12,
      byAgent: [
        {
          agentId: "agent-1",
          name: "Atlas",
          avatarUrl: "/api/assets/asset-1/content",
          runCount: 5,
          eventCount: 6,
          inputTokens: 1_000_000,
          cachedInputTokens: 150_000,
          outputTokens: 30_000,
          totalTokens: 1_180_000,
          tokenBudget: {
            policyId: "policy-1",
            windowKind: "calendar_day_utc",
            windowLabel: "Daily (UTC)",
            windowStart: "2026-09-28T00:00:00.000Z",
            windowEnd: "2026-09-29T00:00:00.000Z",
            limit: 2_000_000,
            observed: 1_180_000,
            utilizationPercent: 59,
            hardStopEnabled: true,
          },
        },
        {
          agentId: "agent-2",
          name: "Bolt",
          avatarUrl: null,
          runCount: 2,
          eventCount: 3,
          inputTokens: 500_000,
          cachedInputTokens: 50_000,
          outputTokens: 20_000,
          totalTokens: 570_000,
          tokenBudget: null,
        },
      ],
      families: [
        {
          family: "claude",
          label: "Claude",
          inputTokens: 1_500_000,
          cachedInputTokens: 200_000,
          outputTokens: 50_000,
          totalTokens: 1_750_000,
          costCents: 1234,
          runCount: 7,
          eventCount: 9,
          costCentsPerHour: 102.83,
          tokensPerHour: 145_833.33,
        },
        {
          family: "gemini",
          label: "Gemini",
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          totalTokens: null,
          costCents: 80,
          runCount: 1,
          eventCount: 1,
          costCentsPerHour: 6.67,
          tokensPerHour: null,
        },
      ],
      totals: {
        inputTokens: 1_500_000,
        cachedInputTokens: 200_000,
        outputTokens: 50_000,
        totalTokens: 1_750_000,
        costCents: 1314,
        runCount: 8,
        costCentsPerHour: 109.5,
        tokensPerHour: 145_833.33,
      },
    },
    {
      period: "7d",
      label: "7 days",
      from: "2026-09-21T12:00:00.000Z",
      to: "2026-09-28T12:00:00.000Z",
      elapsedHours: 168,
      byAgent: [],
      families: [],
      totals: {
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costCents: 0,
        runCount: 0,
        costCentsPerHour: 0,
        tokensPerHour: null,
      },
    },
    {
      period: "30d",
      label: "30 days",
      from: "2026-08-29T12:00:00.000Z",
      to: "2026-09-28T12:00:00.000Z",
      elapsedHours: 720,
      byAgent: [],
      families: [],
      totals: {
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costCents: 0,
        runCount: 0,
        costCentsPerHour: 0,
        tokensPerHour: null,
      },
    },
  ],
};

describe("usageTone", () => {
  it("maps percentages onto the ok / warn / danger thresholds", () => {
    expect(usageTone(0)).toBe("ok");
    expect(usageTone(59.9)).toBe("ok");
    expect(usageTone(60)).toBe("warn");
    expect(usageTone(85)).toBe("warn");
    expect(usageTone(85.1)).toBe("danger");
    expect(usageTone(100)).toBe("danger");
  });
});

describe("formatResetsIn", () => {
  it("renders relative reset text", () => {
    expect(formatResetsIn("2026-09-28T14:59:59Z", NOW)).toBe("resets in 3h");
    expect(formatResetsIn("2026-09-28T12:25:00Z", NOW)).toBe("resets in 25m");
    expect(formatResetsIn("2026-09-30T14:30:00Z", NOW)).toBe("resets in 2d 2h");
    expect(formatResetsIn("2026-09-28T11:00:00Z", NOW)).toBe("resets now");
    expect(formatResetsIn(null, NOW)).toBeNull();
    expect(formatResetsIn("not-a-date", NOW)).toBeNull();
  });
});

describe("ModelUsagePanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    mockAiUsageApi.subscription.mockReset();
    mockAiUsageApi.summary.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.useRealTimers();
  });

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ModelUsagePanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
  }

  it("renders a gauge per window with percent used, remaining, reset text and tone", async () => {
    mockAiUsageApi.subscription.mockResolvedValue(availableUsage);
    mockAiUsageApi.summary.mockResolvedValue(summary);
    await render();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="usage-gauge-five_hour"]')).not.toBeNull();
    });

    const fiveHour = container.querySelector('[data-testid="usage-gauge-five_hour"]')!;
    expect(fiveHour.getAttribute("data-tone")).toBe("danger");
    expect(fiveHour.textContent).toContain("96% used");
    expect(fiveHour.textContent).toContain("4% remaining");
    expect(fiveHour.textContent).toContain("resets in 3h");
    expect(fiveHour.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("96");

    const sevenDay = container.querySelector('[data-testid="usage-gauge-seven_day"]')!;
    expect(sevenDay.getAttribute("data-tone")).toBe("ok");
    expect(sevenDay.textContent).toContain("26% used");
    expect(sevenDay.textContent).toContain("74% remaining");
    expect(sevenDay.textContent).toContain("resets in 2d 2h");

    const sonnet = container.querySelector('[data-testid="usage-gauge-seven_day_sonnet"]')!;
    expect(sonnet.getAttribute("data-tone")).toBe("warn");
    expect(sonnet.textContent).toContain("72.5% used");
    expect(sonnet.textContent).not.toContain("resets");

    expect(mockAiUsageApi.subscription).toHaveBeenCalledWith("company-1");
    expect(mockAiUsageApi.summary).toHaveBeenCalledWith("company-1");
  });

  it("renders the per-family table for the selected period and switches periods", async () => {
    mockAiUsageApi.subscription.mockResolvedValue(availableUsage);
    mockAiUsageApi.summary.mockResolvedValue(summary);
    await render();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="usage-summary-table"]')).not.toBeNull();
    });

    const claude = container.querySelector('[data-testid="usage-family-claude"]')!;
    expect(claude.textContent).toContain("Claude");
    expect(claude.textContent).toContain("7 runs");
    expect(claude.textContent).toContain("1.5M");
    expect(claude.textContent).toContain("$12.34");
    expect(claude.textContent).toContain("$1.03/h");
    expect(claude.textContent).toContain("145.8k tok/h");

    // Cost-only adapters show a dash instead of zero tokens.
    const gemini = container.querySelector('[data-testid="usage-family-gemini"]')!;
    expect(gemini.textContent).toContain("—");
    expect(gemini.textContent).toContain("$0.80");

    const sevenDayTab = container.querySelector<HTMLButtonElement>('[data-testid="usage-period-7d"]')!;
    expect(sevenDayTab.textContent).toBe("7 days");
    await act(async () => {
      sevenDayTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      sevenDayTab.click();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="usage-summary-empty"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="usage-summary-table"]')).toBeNull();
  });

  it("renders the per-agent table with a limit bar for agents that have a token policy", async () => {
    mockAiUsageApi.subscription.mockResolvedValue(availableUsage);
    mockAiUsageApi.summary.mockResolvedValue(summary);
    await render();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="usage-agent-table"]')).not.toBeNull();
    });

    const rows = Array.from(container.querySelectorAll('[data-testid^="usage-agent-"]')).filter((el) => el.tagName === "TR");
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual(["usage-agent-agent-1", "usage-agent-agent-2"]);

    const atlas = container.querySelector('[data-testid="usage-agent-agent-1"]')!;
    expect(atlas.textContent).toContain("Atlas");
    expect(atlas.textContent).toContain("1.2M");
    expect(atlas.querySelector("img")!.getAttribute("src")).toBe("/api/assets/asset-1/content");
    const limit = atlas.querySelector('[data-testid="usage-agent-limit"]')!;
    expect(limit.getAttribute("data-tone")).toBe("ok");
    expect(limit.textContent).toContain("1.2M / 2.0M daily limit");
    expect(limit.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("59");

    const bolt = container.querySelector('[data-testid="usage-agent-agent-2"]')!;
    expect(bolt.querySelector('[data-testid="usage-agent-limit"]')).toBeNull();
    expect(bolt.textContent).toContain("—");
  });

  it("shows a clear not-connected state when the subscription is unavailable", async () => {
    mockAiUsageApi.subscription.mockResolvedValue({
      available: false,
      provider: "anthropic",
      reason: "No Claude subscription is connected for this organization.",
    } satisfies AiSubscriptionUsage);
    mockAiUsageApi.summary.mockResolvedValue(summary);
    await render();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="usage-subscription-unavailable"]')).not.toBeNull();
    });
    const unavailable = container.querySelector('[data-testid="usage-subscription-unavailable"]')!;
    expect(unavailable.textContent).toContain("Claude subscription not connected.");
    expect(unavailable.textContent).toContain("No Claude subscription is connected for this organization.");
    expect(container.querySelector('[data-testid^="usage-gauge-"]')).toBeNull();
    // The totals table still renders independently of the subscription gauges.
    expect(container.querySelector('[data-testid="usage-summary-table"]')).not.toBeNull();
  });

  it("surfaces request failures instead of hiding them", async () => {
    mockAiUsageApi.subscription.mockRejectedValue(new Error("network down"));
    mockAiUsageApi.summary.mockRejectedValue(new Error("summary failed"));
    await render();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="usage-subscription-error"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="usage-summary-error"]')).not.toBeNull();
    });
    expect(container.textContent).toContain("network down");
    expect(container.textContent).toContain("summary failed");
  });
});
