import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents } from "@paperclipai/db";
import {
  AI_SUBSCRIPTION_WINDOW_LABELS,
  AI_USAGE_MODEL_FAMILY_LABELS,
  AI_USAGE_PERIOD_LABELS,
  AI_USAGE_PERIODS,
  modelFamilyForModel,
  type AiSubscriptionUsage,
  type AiSubscriptionUsageWindow,
  type AiUsageFamilyTotals,
  type AiUsageModelFamily,
  type AiUsagePeriod,
  type AiUsagePeriodSummary,
  type AiUsageSummary,
} from "@paperclipai/shared";
import { aiConnectionService } from "./ai-connections.js";

export const ANTHROPIC_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const AI_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 8_000;
const HOUR_MS = 60 * 60 * 1000;

/** Known Anthropic windows, in display order. Unknown non-null object windows are appended. */
const KNOWN_WINDOW_KEYS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const;
const IGNORED_WINDOW_KEYS = new Set(["extra_usage"]);

export interface AiUsageCostRow {
  provider: string;
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  eventCount: number;
  /** events that reported at least one token count */
  tokenEventCount: number;
  runCount: number;
}

export interface AiUsageServiceDeps {
  resolveCredential?: (
    companyId: string,
    userId: string,
  ) => Promise<{ connectionId: string; grantId: string; value: string } | null>;
  loadCostRows?: (companyId: string, from: Date, to: Date) => Promise<AiUsageCostRow[]>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  cacheTtlMs?: number;
}

interface CacheEntry {
  expiresAt: number;
  value: Extract<AiSubscriptionUsage, { available: true }>;
}

// Keyed by company + grant so two users with different personal subscriptions
// in the same company never see each other's quota, while one shared company
// grant is fetched at most once per TTL for everyone.
const subscriptionCache = new Map<string, CacheEntry>();

export function clearAiUsageCache() {
  subscriptionCache.clear();
}

function unavailable(reason: string): AiSubscriptionUsage {
  return { available: false, provider: "anthropic", reason };
}

function clampPercent(value: number): number {
  const bounded = Math.min(100, Math.max(0, value));
  return Math.round(bounded * 10) / 10;
}

function readWindow(key: string, raw: unknown): AiSubscriptionUsageWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const utilization = (raw as Record<string, unknown>).utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  const resetsAt = (raw as Record<string, unknown>).resets_at;
  return {
    key,
    label: AI_SUBSCRIPTION_WINDOW_LABELS[key] ?? key.replace(/_/g, " "),
    utilization: clampPercent(utilization),
    resetsAt: typeof resetsAt === "string" && resetsAt.length > 0 ? resetsAt : null,
  };
}

/** Map the raw Anthropic usage payload to the windows the dashboard renders. */
export function parseAnthropicUsagePayload(body: unknown): AiSubscriptionUsageWindow[] {
  if (typeof body !== "object" || body === null) return [];
  const record = body as Record<string, unknown>;
  const windows: AiSubscriptionUsageWindow[] = [];
  for (const key of KNOWN_WINDOW_KEYS) {
    const window = readWindow(key, record[key]);
    if (window) windows.push(window);
  }
  for (const [key, raw] of Object.entries(record)) {
    if ((KNOWN_WINDOW_KEYS as readonly string[]).includes(key) || IGNORED_WINDOW_KEYS.has(key)) continue;
    const window = readWindow(key, raw);
    if (window) windows.push(window);
  }
  return windows;
}

async function fetchAnthropicUsage(
  token: string,
  fetchImpl: typeof fetch,
): Promise<AiSubscriptionUsageWindow[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(ANTHROPIC_OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Anthropic usage API returned ${resp.status}`);
    return parseAnthropicUsagePayload(await resp.json());
  } finally {
    clearTimeout(timer);
  }
}

function periodStart(period: AiUsagePeriod, now: Date): Date {
  switch (period) {
    case "today":
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    case "7d":
      return new Date(now.getTime() - 7 * 24 * HOUR_MS);
    case "30d":
      return new Date(now.getTime() - 30 * 24 * HOUR_MS);
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function perHour(value: number | null, hours: number): number | null {
  if (value == null) return null;
  return round2(value / hours);
}

/** Aggregate raw provider/model rows into per-family totals for one period. */
export function buildPeriodSummary(
  period: AiUsagePeriod,
  rows: AiUsageCostRow[],
  from: Date,
  to: Date,
): AiUsagePeriodSummary {
  const elapsedHours = Math.max(1, (to.getTime() - from.getTime()) / HOUR_MS);
  const buckets = new Map<
    AiUsageModelFamily,
    { input: number; cached: number; output: number; cost: number; runs: number; events: number; tokenEvents: number }
  >();
  for (const row of rows) {
    const family = modelFamilyForModel(row.model, row.provider);
    const bucket = buckets.get(family) ?? { input: 0, cached: 0, output: 0, cost: 0, runs: 0, events: 0, tokenEvents: 0 };
    bucket.input += Number(row.inputTokens) || 0;
    bucket.cached += Number(row.cachedInputTokens) || 0;
    bucket.output += Number(row.outputTokens) || 0;
    bucket.cost += Number(row.costCents) || 0;
    bucket.runs += Number(row.runCount) || 0;
    bucket.events += Number(row.eventCount) || 0;
    bucket.tokenEvents += Number(row.tokenEventCount) || 0;
    buckets.set(family, bucket);
  }

  const families: AiUsageFamilyTotals[] = [];
  for (const [family, bucket] of buckets) {
    if (bucket.events === 0) continue;
    const hasTokens = bucket.tokenEvents > 0;
    const totalTokens = hasTokens ? bucket.input + bucket.cached + bucket.output : null;
    families.push({
      family,
      label: AI_USAGE_MODEL_FAMILY_LABELS[family],
      inputTokens: hasTokens ? bucket.input : null,
      cachedInputTokens: hasTokens ? bucket.cached : null,
      outputTokens: hasTokens ? bucket.output : null,
      totalTokens,
      costCents: bucket.cost,
      runCount: bucket.runs,
      eventCount: bucket.events,
      costCentsPerHour: perHour(bucket.cost, elapsedHours) ?? 0,
      tokensPerHour: perHour(totalTokens, elapsedHours),
    });
  }
  families.sort((a, b) => b.costCents - a.costCents || (b.totalTokens ?? 0) - (a.totalTokens ?? 0));

  const anyTokens = families.some((f) => f.totalTokens != null);
  const sumTokens = (pick: (f: AiUsageFamilyTotals) => number | null) =>
    anyTokens ? families.reduce((acc, f) => acc + (pick(f) ?? 0), 0) : null;
  const totalTokens = sumTokens((f) => f.totalTokens);
  const costCents = families.reduce((acc, f) => acc + f.costCents, 0);

  return {
    period,
    label: AI_USAGE_PERIOD_LABELS[period],
    from: from.toISOString(),
    to: to.toISOString(),
    elapsedHours: round2(elapsedHours),
    families,
    totals: {
      inputTokens: sumTokens((f) => f.inputTokens),
      cachedInputTokens: sumTokens((f) => f.cachedInputTokens),
      outputTokens: sumTokens((f) => f.outputTokens),
      totalTokens,
      costCents,
      runCount: families.reduce((acc, f) => acc + f.runCount, 0),
      costCentsPerHour: perHour(costCents, elapsedHours) ?? 0,
      tokensPerHour: perHour(totalTokens, elapsedHours),
    },
  };
}

async function loadCostRowsFromDb(db: Db, companyId: string, from: Date, to: Date): Promise<AiUsageCostRow[]> {
  const rows = await db
    .select({
      provider: costEvents.provider,
      model: costEvents.model,
      costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
      inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::double precision`,
      cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::double precision`,
      outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
      eventCount: sql<number>`count(*)::int`,
      tokenEventCount: sql<number>`count(*) filter (where ${costEvents.inputTokens} > 0 or ${costEvents.cachedInputTokens} > 0 or ${costEvents.outputTokens} > 0)::int`,
      runCount: sql<number>`count(distinct ${costEvents.heartbeatRunId})::int`,
    })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, from),
        lte(costEvents.occurredAt, to),
      ),
    )
    .groupBy(costEvents.provider, costEvents.model);
  return rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    costCents: Number(row.costCents),
    inputTokens: Number(row.inputTokens),
    cachedInputTokens: Number(row.cachedInputTokens),
    outputTokens: Number(row.outputTokens),
    eventCount: Number(row.eventCount),
    tokenEventCount: Number(row.tokenEventCount),
    runCount: Number(row.runCount),
  }));
}

export function aiUsageService(db: Db, deps: AiUsageServiceDeps = {}) {
  const connections = aiConnectionService(db);
  const resolveCredential =
    deps.resolveCredential ??
    ((companyId: string, userId: string) =>
      connections.resolveSubscriptionCredential(companyId, userId, "anthropic"));
  const loadCostRows =
    deps.loadCostRows ?? ((companyId: string, from: Date, to: Date) => loadCostRowsFromDb(db, companyId, from, to));
  const fetchImpl = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? (() => new Date());
  const cacheTtlMs = deps.cacheTtlMs ?? AI_USAGE_CACHE_TTL_MS;

  return {
    /**
     * Live Anthropic subscription quota for the company, seen through the
     * requesting board user's permitted connections. Never throws for
     * expected conditions: a missing connection or an upstream failure
     * returns `{ available: false, reason }`.
     */
    subscriptionUsage: async (companyId: string, userId: string): Promise<AiSubscriptionUsage> => {
      let credential: Awaited<ReturnType<typeof resolveCredential>>;
      try {
        credential = await resolveCredential(companyId, userId);
      } catch {
        return unavailable("Could not resolve the Claude subscription connection.");
      }
      if (!credential) {
        return unavailable("No Claude subscription is connected for this organization.");
      }
      const cacheKey = `${companyId}:${credential.grantId}`;
      const nowMs = now().getTime();
      const cached = subscriptionCache.get(cacheKey);
      if (cached && cached.expiresAt > nowMs) return cached.value;

      try {
        const windows = await fetchAnthropicUsage(credential.value, fetchImpl);
        const value: Extract<AiSubscriptionUsage, { available: true }> = {
          available: true,
          provider: "anthropic",
          windows,
          fetchedAt: new Date(nowMs).toISOString(),
        };
        subscriptionCache.set(cacheKey, { expiresAt: nowMs + cacheTtlMs, value });
        return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = /abort/i.test(message)
          ? "The Anthropic usage API did not respond in time."
          : `Could not load Claude subscription usage (${message}).`;
        return unavailable(reason);
      }
    },

    /** Token and cost totals per model family for today / 7 days / 30 days. */
    summary: async (companyId: string): Promise<AiUsageSummary> => {
      const to = now();
      const periods = await Promise.all(
        AI_USAGE_PERIODS.map(async (period) => {
          const from = periodStart(period, to);
          const rows = await loadCostRows(companyId, from, to);
          return buildPeriodSummary(period, rows, from, to);
        }),
      );
      return { companyId, generatedAt: to.toISOString(), periods };
    },
  };
}
