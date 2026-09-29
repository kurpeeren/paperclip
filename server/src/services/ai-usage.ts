import { execFile } from "node:child_process";
import os from "node:os";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents } from "@paperclipai/db";
import {
  AI_SUBSCRIPTION_WINDOW_LABELS,
  AI_USAGE_MODEL_FAMILY_LABELS,
  AI_USAGE_PERIOD_LABELS,
  AI_USAGE_PERIODS,
  modelFamilyForModel,
  type AiSubscriptionProvider,
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
/** Google Antigravity CLI: `agy -p /usage` prints the subscription quota table without a model call. */
export const ANTIGRAVITY_USAGE_COMMAND = "agy";
export const ANTIGRAVITY_USAGE_ARGS = ["--output-format", "text", "-p", "/usage"];
const ANTIGRAVITY_USAGE_TIMEOUT_MS = 45_000;
const ANTIGRAVITY_CACHE_KEY = "antigravity";
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
  /** Runs the Antigravity CLI usage command and resolves with its stdout (overridable for tests). */
  runAntigravityUsage?: () => Promise<string>;
  now?: () => Date;
  cacheTtlMs?: number;
}

interface CacheEntry {
  expiresAt: number;
  value: Extract<AiSubscriptionUsage, { available: true }>;
}

/** After an upstream failure, wait this long before asking Anthropic again (longer on 429). */
export const AI_USAGE_ERROR_BACKOFF_MS = 60 * 1000;
export const AI_USAGE_RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;

interface BackoffEntry {
  until: number;
  reason: string;
}

// Keyed by company + grant so two users with different personal subscriptions
// in the same company never see each other's quota, while one shared company
// grant is fetched at most once per TTL for everyone.
const subscriptionCache = new Map<string, CacheEntry>();
// Last successful fetch per key, kept beyond the TTL so a failed refresh (429, timeout)
// degrades to a stale gauge instead of an empty panel.
const lastGoodCache = new Map<string, CacheEntry["value"]>();
const backoffCache = new Map<string, BackoffEntry>();

export function clearAiUsageCache() {
  subscriptionCache.clear();
  lastGoodCache.clear();
  backoffCache.clear();
}

function staleOrUnavailable(
  cacheKey: string,
  reason: string,
  provider: AiSubscriptionProvider = "anthropic",
): AiSubscriptionUsage {
  const lastGood = lastGoodCache.get(cacheKey);
  if (lastGood) return { ...lastGood, stale: true, staleReason: reason };
  return unavailable(reason, provider);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Parse the tab-separated table printed by `agy -p /usage`, e.g.
 * `Gemini Models\tFive Hour Limit Remaining\t97%\t2026-09-28T17:28:16Z`.
 * The CLI reports the REMAINING share, so utilization is its complement.
 */
export function parseAntigravityUsageOutput(text: string): AiSubscriptionUsageWindow[] {
  const windows: AiSubscriptionUsageWindow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const parts = rawLine.split("\t").map((part) => part.trim());
    if (parts.length < 3) continue;
    const [group, rawLabel, rawPercent, rawReset] = parts;
    const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(rawPercent ?? "");
    if (!group || !rawLabel || !match) continue;
    const remaining = Number(match[1]);
    const kind = /week/i.test(rawLabel) ? "seven_day" : /five\s*hour|5[- ]hour/i.test(rawLabel) ? "five_hour" : slug(rawLabel);
    const kindLabel = kind === "five_hour" ? "5-hour window" : kind === "seven_day" ? "7-day window" : rawLabel;
    const resetsAt = rawReset && !Number.isNaN(Date.parse(rawReset)) ? new Date(rawReset).toISOString() : null;
    windows.push({
      key: `antigravity_${slug(group)}_${kind}`,
      label: `${group} · ${kindLabel}`,
      utilization: Math.min(100, Math.max(0, 100 - remaining)),
      resetsAt,
    });
  }
  return windows;
}

function runAntigravityUsageCommand(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ANTIGRAVITY_USAGE_COMMAND,
      ANTIGRAVITY_USAGE_ARGS,
      {
        cwd: os.tmpdir(),
        timeout: ANTIGRAVITY_USAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CI: "1", NO_COLOR: "1", TERM: "dumb" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return reject(new Error("agy CLI not found on the server PATH"));
          if (error.killed) return reject(new Error("agy did not respond in time"));
          return reject(new Error(String(stderr || error.message).trim().slice(0, 200)));
        }
        resolve(String(stdout));
      },
    );
  });
}

function unavailable(reason: string, provider: AiSubscriptionProvider = "anthropic"): AiSubscriptionUsage {
  return { available: false, provider, reason };
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
  const runAntigravityUsage = deps.runAntigravityUsage ?? runAntigravityUsageCommand;
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
      const backoff = backoffCache.get(cacheKey);
      if (backoff && backoff.until > nowMs) return staleOrUnavailable(cacheKey, backoff.reason);

      try {
        const windows = await fetchAnthropicUsage(credential.value, fetchImpl);
        const value: Extract<AiSubscriptionUsage, { available: true }> = {
          available: true,
          provider: "anthropic",
          windows,
          fetchedAt: new Date(nowMs).toISOString(),
        };
        subscriptionCache.set(cacheKey, { expiresAt: nowMs + cacheTtlMs, value });
        lastGoodCache.set(cacheKey, value);
        backoffCache.delete(cacheKey);
        return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const rateLimited = /\b429\b/.test(message);
        const reason = /abort/i.test(message)
          ? "The Anthropic usage API did not respond in time."
          : rateLimited
            ? "Anthropic usage API rate-limited this refresh (429); showing the last successful reading."
            : `Could not load Claude subscription usage (${message}).`;
        backoffCache.set(cacheKey, {
          until: nowMs + (rateLimited ? AI_USAGE_RATE_LIMIT_BACKOFF_MS : AI_USAGE_ERROR_BACKOFF_MS),
          reason,
        });
        return staleOrUnavailable(cacheKey, reason);
      }
    },

    /**
     * Google Antigravity subscription quota, read from the locally signed-in
     * `agy` CLI on the server host (machine-level, not per user). Never throws
     * for expected conditions: a missing CLI or a failed run returns
     * `{ available: false, reason }` or the last good reading flagged stale.
     */
    antigravityUsage: async (): Promise<AiSubscriptionUsage> => {
      const nowMs = now().getTime();
      const cached = subscriptionCache.get(ANTIGRAVITY_CACHE_KEY);
      if (cached && cached.expiresAt > nowMs) return cached.value;
      const backoff = backoffCache.get(ANTIGRAVITY_CACHE_KEY);
      if (backoff && backoff.until > nowMs) return staleOrUnavailable(ANTIGRAVITY_CACHE_KEY, backoff.reason, "antigravity");
      try {
        const windows = parseAntigravityUsageOutput(await runAntigravityUsage());
        if (windows.length === 0) throw new Error("agy /usage printed no quota rows");
        const value: Extract<AiSubscriptionUsage, { available: true }> = {
          available: true,
          provider: "antigravity",
          windows,
          fetchedAt: new Date(nowMs).toISOString(),
        };
        subscriptionCache.set(ANTIGRAVITY_CACHE_KEY, { expiresAt: nowMs + cacheTtlMs, value });
        lastGoodCache.set(ANTIGRAVITY_CACHE_KEY, value);
        backoffCache.delete(ANTIGRAVITY_CACHE_KEY);
        return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `Could not load Antigravity usage (${message}).`;
        backoffCache.set(ANTIGRAVITY_CACHE_KEY, { until: nowMs + AI_USAGE_ERROR_BACKOFF_MS, reason });
        return staleOrUnavailable(ANTIGRAVITY_CACHE_KEY, reason, "antigravity");
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
