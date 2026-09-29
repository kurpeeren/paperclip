import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import type {
  AiSubscriptionUsage,
  AiSubscriptionUsageWindow,
  AiUsageAgentTotals,
  AiUsagePeriod,
  AiUsagePeriodSummary,
  AiUsageSummary,
} from "@paperclipai/shared";
import { AI_USAGE_PERIODS } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { aiUsageApi } from "../api/ai-usage";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatCents, formatTokens } from "../lib/utils";

export const MODEL_USAGE_REFRESH_MS = 5 * 60 * 1000;

export type UsageTone = "ok" | "warn" | "danger";

/** Threshold colouring for a used-percent value: <60 ok, 60-85 warn, >85 danger. */
export function usageTone(percentUsed: number): UsageTone {
  if (percentUsed > 85) return "danger";
  if (percentUsed >= 60) return "warn";
  return "ok";
}

/** Relative "resets in" text for a window reset timestamp; null when unknown or already passed. */
export function formatResetsIn(resetsAt: string | null | undefined, nowMs: number = Date.now()): string | null {
  if (!resetsAt) return null;
  const target = new Date(resetsAt).getTime();
  if (!Number.isFinite(target)) return null;
  const diffMinutes = Math.round((target - nowMs) / 60_000);
  if (diffMinutes <= 0) return "resets now";
  if (diffMinutes < 60) return `resets in ${diffMinutes}m`;
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  if (hours < 24) return minutes > 0 ? `resets in ${hours}h ${minutes}m` : `resets in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `resets in ${days}d ${remHours}h` : `resets in ${days}d`;
}

const TONE_FILL: Record<UsageTone, string> = {
  ok: "bg-(--status-task-done)",
  warn: "bg-(--status-task-todo)",
  danger: "bg-(--status-task-blocked)",
};

const TONE_TEXT: Record<UsageTone, string> = {
  ok: "text-foreground",
  warn: "text-(--status-task-icon-todo)",
  danger: "text-(--status-task-blocked)",
};

function formatPercent(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

function formatCentsPerHour(cents: number): string {
  return `${formatCents(cents)}/h`;
}

function formatMaybeTokens(value: number | null): string {
  return value == null ? "—" : formatTokens(value);
}

export function UsageGauge({ window }: { window: AiSubscriptionUsageWindow }) {
  const used = Math.min(100, Math.max(0, window.utilization));
  const remaining = Math.max(0, 100 - used);
  const tone = usageTone(used);
  const resets = formatResetsIn(window.resetsAt);
  return (
    <div className="space-y-1.5" data-testid={`usage-gauge-${window.key}`} data-tone={tone}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground truncate">{window.label}</span>
        <span className={cn("text-xs font-semibold tabular-nums shrink-0", TONE_TEXT[tone])}>
          {formatPercent(used)} used
        </span>
      </div>
      <div className="relative h-2 w-full overflow-hidden bg-muted">
        <div
          role="progressbar"
          aria-valuenow={Math.round(used)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${window.label}: ${formatPercent(used)} used`}
          className={cn("absolute inset-y-0 left-0 transition-(--tp-width) duration-200", TONE_FILL[tone])}
          style={{ width: `${used}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-(length:--text-nano) text-muted-foreground tabular-nums">
        <span>{formatPercent(remaining)} remaining</span>
        {resets ? <span>{resets}</span> : null}
      </div>
    </div>
  );
}

function SubscriptionSection({
  data,
  isLoading,
  error,
  providerLabel = "Claude",
  connectHint = "Connect a Claude subscription as an agent's AI connection to see live quota here.",
}: {
  data: AiSubscriptionUsage | undefined;
  isLoading: boolean;
  error: Error | null;
  providerLabel?: string;
  connectHint?: string;
}) {
  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="usage-subscription-loading">
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-2 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <p className="text-sm text-destructive" data-testid="usage-subscription-error">
        Could not load {providerLabel} subscription usage: {error.message}
      </p>
    );
  }
  if (!data) return null;
  if (!data.available) {
    return (
      <div className="space-y-1" data-testid="usage-subscription-unavailable">
        <p className="text-sm text-foreground">{providerLabel} subscription not connected.</p>
        <p className="text-xs text-muted-foreground">{data.reason}</p>
        <p className="text-xs text-muted-foreground">{connectHint}</p>
      </div>
    );
  }
  if (data.windows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="usage-subscription-empty">
        The subscription reported no quota windows.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="grid gap-4 sm:grid-cols-2">
        {data.windows.map((window) => (
          <UsageGauge key={window.key} window={window} />
        ))}
      </div>
      {data.stale ? (
        <p className="text-xs text-muted-foreground" data-testid="usage-subscription-stale">
          Last successful reading {new Date(data.fetchedAt).toLocaleTimeString()}. {data.staleReason}
        </p>
      ) : null}
    </div>
  );
}

function FamilyTable({ period }: { period: AiUsagePeriodSummary }) {
  if (period.families.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="usage-summary-empty">
        No model usage recorded for this period.
      </p>
    );
  }
  return (
    <table className="w-full text-xs tabular-nums" data-testid="usage-summary-table">
      <thead>
        <tr className="text-muted-foreground">
          <th className="text-left font-medium py-1">Model family</th>
          <th className="text-right font-medium py-1">Input</th>
          <th className="text-right font-medium py-1 hidden sm:table-cell">Cache</th>
          <th className="text-right font-medium py-1">Output</th>
          <th className="text-right font-medium py-1">Cost</th>
          <th className="text-right font-medium py-1">Burn</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {period.families.map((family) => (
          <tr key={family.family} data-testid={`usage-family-${family.family}`}>
            <td className="py-1.5 text-foreground">
              {family.label}
              <span className="ml-1 text-muted-foreground">· {family.runCount} run{family.runCount === 1 ? "" : "s"}</span>
            </td>
            <td className="py-1.5 text-right">{formatMaybeTokens(family.inputTokens)}</td>
            <td className="py-1.5 text-right hidden sm:table-cell">{formatMaybeTokens(family.cachedInputTokens)}</td>
            <td className="py-1.5 text-right">{formatMaybeTokens(family.outputTokens)}</td>
            <td className="py-1.5 text-right">{formatCents(family.costCents)}</td>
            <td className="py-1.5 text-right text-muted-foreground">
              {formatCentsPerHour(family.costCentsPerHour)}
              {family.tokensPerHour != null ? ` · ${formatTokens(family.tokensPerHour)} tok/h` : ""}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-border font-medium">
          <td className="py-1.5">Total</td>
          <td className="py-1.5 text-right">{formatMaybeTokens(period.totals.inputTokens)}</td>
          <td className="py-1.5 text-right hidden sm:table-cell">{formatMaybeTokens(period.totals.cachedInputTokens)}</td>
          <td className="py-1.5 text-right">{formatMaybeTokens(period.totals.outputTokens)}</td>
          <td className="py-1.5 text-right">{formatCents(period.totals.costCents)}</td>
          <td className="py-1.5 text-right text-muted-foreground">
            {formatCentsPerHour(period.totals.costCentsPerHour)}
            {period.totals.tokensPerHour != null ? ` · ${formatTokens(period.totals.tokensPerHour)} tok/h` : ""}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function TokenBudgetBar({ budget }: { budget: NonNullable<AiUsageAgentTotals["tokenBudget"]> }) {
  const over = budget.observed >= budget.limit;
  const percent = Math.min(100, Math.max(0, budget.utilizationPercent));
  const tone: UsageTone = over ? "danger" : usageTone(percent);
  const windowWord =
    budget.windowKind === "calendar_day_utc" ? "daily" : budget.windowKind === "calendar_month_utc" ? "monthly" : "lifetime";
  const label = `${formatTokens(budget.observed)} / ${formatTokens(budget.limit)} ${windowWord} limit`;
  return (
    <div className="min-w-28 space-y-0.5" data-testid="usage-agent-limit" data-tone={tone}>
      <div className="relative h-1.5 w-full overflow-hidden bg-muted">
        <div
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} used`}
          className={cn("absolute inset-y-0 left-0", TONE_FILL[tone])}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className={cn("text-(length:--text-nano) tabular-nums whitespace-nowrap", over ? TONE_TEXT.danger : "text-muted-foreground")}>
        {label}
        {over ? " · over" : ""}
      </div>
    </div>
  );
}

/** Per-agent token totals for the selected period, plus each agent's token budget when one is set. */
function AgentTable({ period }: { period: AiUsagePeriodSummary }) {
  if (period.byAgent.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground">By agent</h4>
      <table className="w-full text-xs tabular-nums" data-testid="usage-agent-table">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-medium py-1">Agent</th>
            <th className="text-right font-medium py-1">Runs</th>
            <th className="text-right font-medium py-1">Input</th>
            <th className="text-right font-medium py-1 hidden sm:table-cell">Cache</th>
            <th className="text-right font-medium py-1">Output</th>
            <th className="text-right font-medium py-1">Total</th>
            <th className="text-right font-medium py-1">Limit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {period.byAgent.map((agent) => (
            <tr key={agent.agentId} data-testid={`usage-agent-${agent.agentId}`}>
              <td className="py-1.5 text-foreground">
                <span className="inline-flex min-w-0 items-center gap-2">
                  {agent.avatarUrl ? (
                    <img
                      src={agent.avatarUrl}
                      alt=""
                      width={20}
                      height={20}
                      loading="lazy"
                      decoding="async"
                      className="size-5 shrink-0 rounded-full object-cover"
                    />
                  ) : (
                    <span className="size-5 shrink-0 rounded-full bg-muted" aria-hidden="true" />
                  )}
                  <span className="truncate">{agent.name}</span>
                </span>
              </td>
              <td className="py-1.5 text-right">{agent.runCount}</td>
              <td className="py-1.5 text-right">{formatTokens(agent.inputTokens)}</td>
              <td className="py-1.5 text-right hidden sm:table-cell">{formatTokens(agent.cachedInputTokens)}</td>
              <td className="py-1.5 text-right">{formatTokens(agent.outputTokens)}</td>
              <td className="py-1.5 text-right font-medium">{formatTokens(agent.totalTokens)}</td>
              <td className="py-1.5 pl-3 text-right">
                {agent.tokenBudget ? (
                  <TokenBudgetBar budget={agent.tokenBudget} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummarySection({
  data,
  isLoading,
  error,
}: {
  data: AiUsageSummary | undefined;
  isLoading: boolean;
  error: Error | null;
}) {
  const [period, setPeriod] = useState<AiUsagePeriod>("today");
  const selected = useMemo(
    () => data?.periods.find((entry) => entry.period === period) ?? null,
    [data, period],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-medium text-muted-foreground">Tokens and cost by model family</h4>
        <Tabs value={period} onValueChange={(value) => setPeriod(value as AiUsagePeriod)}>
          <TabsList variant="line" className="h-auto" aria-label="Usage period">
            {AI_USAGE_PERIODS.map((key) => (
              <TabsTrigger key={key} value={key} className="text-xs" data-testid={`usage-period-${key}`}>
                {data?.periods.find((entry) => entry.period === key)?.label ?? key}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {isLoading ? (
        <Skeleton className="h-16 w-full" data-testid="usage-summary-loading" />
      ) : error ? (
        <p className="text-sm text-destructive" data-testid="usage-summary-error">
          Could not load model usage totals: {error.message}
        </p>
      ) : selected ? (
        <>
          <FamilyTable period={selected} />
          <AgentTable period={selected} />
          <p className="text-(length:--text-nano) text-muted-foreground">
            Burn rate averages the elapsed {selected.elapsedHours}h of this period. Tokens show “—” when an adapter reported cost only.
            Limit bars follow the agent's token budget window, not the selected period.
          </p>
        </>
      ) : null}
    </div>
  );
}

export function ModelUsagePanel({ companyId }: { companyId: string }) {
  const subscription = useQuery({
    queryKey: queryKeys.aiUsageSubscription(companyId),
    queryFn: () => aiUsageApi.subscription(companyId),
    enabled: !!companyId,
    refetchInterval: MODEL_USAGE_REFRESH_MS,
    staleTime: 60_000,
  });
  const antigravity = useQuery({
    queryKey: queryKeys.aiUsageAntigravity(companyId),
    queryFn: () => aiUsageApi.antigravity(companyId),
    enabled: !!companyId,
    refetchInterval: MODEL_USAGE_REFRESH_MS,
    staleTime: 60_000,
  });
  const summary = useQuery({
    queryKey: queryKeys.aiUsageSummary(companyId),
    queryFn: () => aiUsageApi.summary(companyId),
    enabled: !!companyId,
    refetchInterval: MODEL_USAGE_REFRESH_MS,
    staleTime: 60_000,
  });

  return (
    <Card className="block gap-0 py-0" data-testid="model-usage-panel">
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div>
          <h3 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
            Model usage
          </h3>
          <p className="text-(length:--text-nano) text-muted-foreground/60">
            Claude and Antigravity subscription quotas and token burn · refreshes every 5 minutes
          </p>
        </div>
        <Link to="/costs" className="text-xs underline underline-offset-2 text-muted-foreground shrink-0">
          Open costs
        </Link>
      </div>
      <div className="px-4 py-4 space-y-5">
        <div className="space-y-3">
          <h4 className="text-xs font-medium text-muted-foreground">Claude subscription</h4>
          <SubscriptionSection
            data={subscription.data}
            isLoading={subscription.isLoading}
            error={subscription.error as Error | null}
          />
        </div>
        <div className="space-y-3">
          <h4 className="text-xs font-medium text-muted-foreground">Antigravity (Google) subscription</h4>
          <SubscriptionSection
            data={antigravity.data}
            isLoading={antigravity.isLoading}
            error={antigravity.error as Error | null}
            providerLabel="Antigravity"
            connectHint="Sign in to the agy CLI on the Paperclip host (agy login) to see Google Antigravity quota here."
          />
        </div>
        <SummarySection data={summary.data} isLoading={summary.isLoading} error={summary.error as Error | null} />
      </div>
    </Card>
  );
}
