import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_OAUTH_USAGE_URL,
  aiUsageService,
  buildAgentTotals,
  buildPeriodSummary,
  clearAiUsageCache,
  parseAnthropicUsagePayload,
  type AiUsageAgentRow,
  type AiUsageAgentTokenPolicy,
  type AiUsageCostRow,
} from "./ai-usage.js";

const USAGE_BODY = {
  five_hour: { utilization: 96.0, resets_at: "2026-09-28T14:59:59Z" },
  seven_day: { utilization: 26.4, resets_at: "2026-10-02T00:00:00Z" },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 12, resets_at: null },
  extra_usage: { is_enabled: false, utilization: 0 },
};

function okResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("parseAnthropicUsagePayload", () => {
  it("keeps known windows in display order, skips null and extra_usage", () => {
    const windows = parseAnthropicUsagePayload(USAGE_BODY);
    expect(windows.map((w) => w.key)).toEqual(["five_hour", "seven_day", "seven_day_sonnet"]);
    expect(windows[0]).toEqual({
      key: "five_hour",
      label: "5-hour window",
      utilization: 96,
      resetsAt: "2026-09-28T14:59:59Z",
    });
    expect(windows[2]!.resetsAt).toBeNull();
  });

  it("clamps utilization to 0-100 and appends unknown object windows", () => {
    const windows = parseAnthropicUsagePayload({
      five_hour: { utilization: 130 },
      seven_day_haiku: { utilization: -4, resets_at: "x" },
      not_a_window: "text",
    });
    expect(windows).toEqual([
      { key: "five_hour", label: "5-hour window", utilization: 100, resetsAt: null },
      { key: "seven_day_haiku", label: "seven day haiku", utilization: 0, resetsAt: "x" },
    ]);
  });

  it("returns no windows for a non-object payload", () => {
    expect(parseAnthropicUsagePayload(null)).toEqual([]);
    expect(parseAnthropicUsagePayload("nope")).toEqual([]);
  });
});

describe("aiUsageService.subscriptionUsage", () => {
  const db = {} as any;
  let clock = Date.parse("2026-09-28T12:00:00Z");
  const now = () => new Date(clock);
  const credential = { connectionId: "conn-1", grantId: "grant-1", value: "oauth-token-secret" };

  beforeEach(() => {
    clearAiUsageCache();
    clock = Date.parse("2026-09-28T12:00:00Z");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the Anthropic usage endpoint with the bearer token and beta header", async () => {
    const fetchImpl = vi.fn(async () => okResponse(USAGE_BODY));
    const service = aiUsageService(db, {
      resolveCredential: async () => credential,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now,
    });
    const result = await service.subscriptionUsage("company-1", "user-1");
    expect(result).toEqual({
      available: true,
      provider: "anthropic",
      fetchedAt: "2026-09-28T12:00:00.000Z",
      windows: parseAnthropicUsagePayload(USAGE_BODY),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ANTHROPIC_OAUTH_USAGE_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer oauth-token-secret");
    expect((init.headers as Record<string, string>)["anthropic-beta"]).toBe("oauth-2025-04-20");
    // The credential must never leak into the response body.
    expect(JSON.stringify(result)).not.toContain("oauth-token-secret");
  });

  it("serves the cached result for five minutes and refetches afterwards", async () => {
    const fetchImpl = vi.fn(async () => okResponse(USAGE_BODY));
    const service = aiUsageService(db, {
      resolveCredential: async () => credential,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now,
    });
    const first = await service.subscriptionUsage("company-1", "user-1");
    clock += 4 * 60 * 1000;
    const second = await service.subscriptionUsage("company-1", "user-1");
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 2 * 60 * 1000;
    const third = await service.subscriptionUsage("company-1", "user-1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(third).not.toBe(first);
    expect(third.available && third.fetchedAt).toBe("2026-09-28T12:06:00.000Z");
  });

  it("keeps caches separate per company and per grant", async () => {
    const fetchImpl = vi.fn(async () => okResponse(USAGE_BODY));
    const service = aiUsageService(db, {
      resolveCredential: async (companyId, userId) => ({
        ...credential,
        grantId: `${companyId}:${userId}`,
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now,
    });
    await service.subscriptionUsage("company-1", "user-1");
    await service.subscriptionUsage("company-1", "user-2");
    await service.subscriptionUsage("company-2", "user-1");
    await service.subscriptionUsage("company-1", "user-1");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("reports available:false when no subscription connection resolves", async () => {
    const fetchImpl = vi.fn();
    const service = aiUsageService(db, {
      resolveCredential: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now,
    });
    await expect(service.subscriptionUsage("company-1", "user-1")).resolves.toEqual({
      available: false,
      provider: "anthropic",
      reason: "No Claude subscription is connected for this organization.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports available:false when credential resolution throws", async () => {
    const service = aiUsageService(db, {
      resolveCredential: async () => {
        throw new Error("boom");
      },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      now,
    });
    const result = await service.subscriptionUsage("company-1", "user-1");
    expect(result.available).toBe(false);
    expect(JSON.stringify(result)).not.toContain("boom");
  });

  it("reports available:false on upstream HTTP errors and does not cache them", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(okResponse(USAGE_BODY));
    const service = aiUsageService(db, {
      resolveCredential: async () => credential,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now,
    });
    const failed = await service.subscriptionUsage("company-1", "user-1");
    expect(failed).toEqual({
      available: false,
      provider: "anthropic",
      reason: "Could not load Claude subscription usage (Anthropic usage API returned 401).",
    });
    const recovered = await service.subscriptionUsage("company-1", "user-1");
    expect(recovered.available).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports a timeout reason when the upstream call aborts", async () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    const service = aiUsageService(db, {
      resolveCredential: async () => credential,
      fetchImpl: vi.fn(async () => {
        throw abort;
      }) as unknown as typeof fetch,
      now,
    });
    await expect(service.subscriptionUsage("company-1", "user-1")).resolves.toEqual({
      available: false,
      provider: "anthropic",
      reason: "The Anthropic usage API did not respond in time.",
    });
  });
});

describe("buildPeriodSummary", () => {
  const row = (overrides: Partial<AiUsageCostRow>): AiUsageCostRow => ({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    eventCount: 1,
    tokenEventCount: 1,
    runCount: 1,
    ...overrides,
  });

  it("groups rows into model families with per-hour burn rates", () => {
    const from = new Date("2026-09-28T00:00:00Z");
    const to = new Date("2026-09-28T04:00:00Z");
    const summary = buildPeriodSummary(
      "today",
      [
        row({ model: "claude-opus-4-1", costCents: 300, inputTokens: 1000, cachedInputTokens: 200, outputTokens: 400, runCount: 2 }),
        row({ model: "claude-sonnet-4-5", costCents: 100, inputTokens: 500, outputTokens: 100, runCount: 1 }),
        row({ provider: "openai", model: "gpt-5-codex", costCents: 200, inputTokens: 2000, outputTokens: 800, runCount: 3 }),
        row({ provider: "google", model: "gemini-2.5-pro", costCents: 0, inputTokens: 0, outputTokens: 0, tokenEventCount: 0, eventCount: 2 }),
      ],
      from,
      to,
    );
    expect(summary.period).toBe("today");
    expect(summary.elapsedHours).toBe(4);
    expect(summary.families.map((f) => f.family)).toEqual(["claude", "openai", "gemini"]);
    const claude = summary.families[0]!;
    expect(claude).toMatchObject({
      label: "Claude",
      inputTokens: 1500,
      cachedInputTokens: 200,
      outputTokens: 500,
      totalTokens: 2200,
      costCents: 400,
      runCount: 3,
      eventCount: 2,
      costCentsPerHour: 100,
      tokensPerHour: 550,
    });
    // A family with cost-only events reports null tokens instead of 0.
    const gemini = summary.families[2]!;
    expect(gemini.inputTokens).toBeNull();
    expect(gemini.totalTokens).toBeNull();
    expect(gemini.tokensPerHour).toBeNull();
    expect(gemini.eventCount).toBe(2);
    expect(summary.totals).toEqual({
      inputTokens: 3500,
      cachedInputTokens: 200,
      outputTokens: 1300,
      totalTokens: 5000,
      costCents: 600,
      runCount: 7,
      costCentsPerHour: 150,
      tokensPerHour: 1250,
    });
  });

  it("uses at least one elapsed hour so a fresh day does not divide by zero", () => {
    const from = new Date("2026-09-28T00:00:00Z");
    const to = new Date("2026-09-28T00:10:00Z");
    const summary = buildPeriodSummary("today", [row({ costCents: 50, inputTokens: 10 })], from, to);
    expect(summary.elapsedHours).toBe(1);
    expect(summary.totals.costCentsPerHour).toBe(50);
  });

  it("returns empty families and null token totals with no rows", () => {
    const from = new Date("2026-09-21T12:00:00Z");
    const to = new Date("2026-09-28T12:00:00Z");
    const summary = buildPeriodSummary("7d", [], from, to);
    expect(summary.families).toEqual([]);
    expect(summary.byAgent).toEqual([]);
    expect(summary.elapsedHours).toBe(168);
    expect(summary.totals).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costCents: 0,
      runCount: 0,
      costCentsPerHour: 0,
      tokensPerHour: null,
    });
  });
});

const agentRow = (overrides: Partial<AiUsageAgentRow>): AiUsageAgentRow => ({
  agentId: "agent-1",
  name: "Agent One",
  avatarUrl: "/api/assets/asset-1/content",
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  eventCount: 1,
  runCount: 1,
  ...overrides,
});

describe("buildAgentTotals", () => {
  it("sums the three token columns per agent, sorts by total and attaches the token budget", () => {
    const policy: AiUsageAgentTokenPolicy = {
      agentId: "agent-1",
      policyId: "policy-1",
      windowKind: "calendar_day_utc",
      windowStart: new Date("2026-09-28T00:00:00Z"),
      windowEnd: new Date("2026-09-29T00:00:00Z"),
      amount: 20_000_000,
      observed: 12_400_000,
      hardStopEnabled: true,
    };
    const totals = buildAgentTotals(
      [
        agentRow({ agentId: "agent-1", inputTokens: 10_000_000, cachedInputTokens: 2_000_000, outputTokens: 400_000, runCount: 4 }),
        agentRow({ agentId: "agent-2", name: "Agent Two", avatarUrl: null, inputTokens: 30_000_000, outputTokens: 1_000_000, runCount: 9 }),
      ],
      [policy],
    );
    expect(totals.map((t) => t.agentId)).toEqual(["agent-2", "agent-1"]);
    expect(totals[1]).toEqual({
      agentId: "agent-1",
      name: "Agent One",
      avatarUrl: "/api/assets/asset-1/content",
      runCount: 4,
      eventCount: 1,
      inputTokens: 10_000_000,
      cachedInputTokens: 2_000_000,
      outputTokens: 400_000,
      totalTokens: 12_400_000,
      tokenBudget: {
        policyId: "policy-1",
        windowKind: "calendar_day_utc",
        windowLabel: "Daily (UTC)",
        windowStart: "2026-09-28T00:00:00.000Z",
        windowEnd: "2026-09-29T00:00:00.000Z",
        limit: 20_000_000,
        observed: 12_400_000,
        utilizationPercent: 62,
        hardStopEnabled: true,
      },
    });
    expect(totals[0]!.tokenBudget).toBeNull();
    expect(totals[0]!.totalTokens).toBe(31_000_000);
  });

  it("keeps bigint-sized totals exact and reports over-limit utilization above 100", () => {
    const totals = buildAgentTotals(
      [agentRow({ inputTokens: 6_000_000_000, cachedInputTokens: 3_000_000_000, outputTokens: 1_000_000_000 })],
      [{
        agentId: "agent-1",
        policyId: "policy-1",
        windowKind: "calendar_month_utc",
        windowStart: new Date("2026-09-01T00:00:00Z"),
        windowEnd: new Date("2026-10-01T00:00:00Z"),
        amount: 5_000_000_000,
        observed: 10_000_000_000,
        hardStopEnabled: false,
      }],
    );
    expect(totals[0]!.totalTokens).toBe(10_000_000_000);
    expect(totals[0]!.tokenBudget).toMatchObject({ limit: 5_000_000_000, observed: 10_000_000_000, utilizationPercent: 200 });
  });
});

describe("aiUsageService.summary", () => {
  it("queries each period with its own window and labels them", async () => {
    const nowDate = new Date("2026-09-28T06:00:00Z");
    const loadCostRows = vi.fn(async () => []);
    const loadAgentRows = vi.fn(async () => []);
    const loadAgentTokenPolicies = vi.fn(async () => []);
    const service = aiUsageService({} as any, {
      loadCostRows,
      loadAgentRows,
      loadAgentTokenPolicies,
      now: () => nowDate,
      resolveCredential: async () => null,
    });
    const summary = await service.summary("company-1");
    expect(summary.companyId).toBe("company-1");
    expect(summary.generatedAt).toBe("2026-09-28T06:00:00.000Z");
    expect(summary.periods.map((p) => [p.period, p.label, p.from])).toEqual([
      ["today", "Today", "2026-09-28T00:00:00.000Z"],
      ["7d", "7 days", "2026-09-21T06:00:00.000Z"],
      ["30d", "30 days", "2026-08-29T06:00:00.000Z"],
    ]);
    expect(loadCostRows).toHaveBeenCalledTimes(3);
    expect(loadAgentRows).toHaveBeenCalledTimes(3);
    for (const call of loadCostRows.mock.calls as unknown as [string, Date, Date][]) {
      expect(call[0]).toBe("company-1");
      expect(call[2]).toEqual(nowDate);
    }
    // Token policies are evaluated once against their own window, not per period.
    expect(loadAgentTokenPolicies).toHaveBeenCalledTimes(1);
    expect(loadAgentTokenPolicies).toHaveBeenCalledWith("company-1", nowDate);
  });

  it("includes per-agent totals with the token limit in every period", async () => {
    const nowDate = new Date("2026-09-28T06:00:00Z");
    const service = aiUsageService({} as any, {
      loadCostRows: async () => [],
      loadAgentRows: async (_companyId, from) =>
        from.getTime() === Date.UTC(2026, 8, 28) ? [agentRow({ inputTokens: 100, outputTokens: 20, runCount: 2 })] : [],
      loadAgentTokenPolicies: async () => [{
        agentId: "agent-1",
        policyId: "policy-1",
        windowKind: "calendar_day_utc",
        windowStart: new Date("2026-09-28T00:00:00Z"),
        windowEnd: new Date("2026-09-29T00:00:00Z"),
        amount: 1_000,
        observed: 120,
        hardStopEnabled: true,
      }],
      now: () => nowDate,
      resolveCredential: async () => null,
    });
    const summary = await service.summary("company-1");
    const today = summary.periods.find((p) => p.period === "today")!;
    expect(today.byAgent).toHaveLength(1);
    expect(today.byAgent[0]).toMatchObject({
      agentId: "agent-1",
      totalTokens: 120,
      runCount: 2,
      tokenBudget: { limit: 1_000, observed: 120, utilizationPercent: 12, windowLabel: "Daily (UTC)" },
    });
    expect(summary.periods.find((p) => p.period === "7d")!.byAgent).toEqual([]);
  });
});
