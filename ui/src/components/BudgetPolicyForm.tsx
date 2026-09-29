import { useEffect, useMemo, useState } from "react";
import {
  BUDGET_METRICS,
  BUDGET_WINDOW_KINDS,
  type BudgetMetric,
  type BudgetPolicySummary,
  type BudgetPolicyUpsertInput,
  type BudgetScopeType,
  type BudgetWindowKind,
} from "@paperclipai/shared";
import { cn } from "../lib/utils";
import {
  budgetAmountInvalidMessage,
  budgetMetricLabel,
  budgetWindowLabel,
  formatBudgetAmount,
  parseBudgetAmountInput,
  tokenAmountHint,
} from "../lib/budget-format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface BudgetPolicyFormScopeOptions {
  company: { id: string; name: string };
  agents: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
}

type ScopeChoice = { scopeType: BudgetScopeType; scopeId: string };

function defaultWindowFor(metric: BudgetMetric, scopeType: BudgetScopeType): BudgetWindowKind {
  if (metric === "tokens") return "calendar_day_utc";
  return scopeType === "project" ? "lifetime" : "calendar_month_utc";
}

const METRIC_HELP: Record<BudgetMetric, string> = {
  tokens: "Input + cached input + output tokens across every provider. Use this on a flat subscription where billed cents stay at 0.",
  billed_cents: "Metered spend reported by the provider, in US dollars.",
};

/**
 * Create or update one budget policy: pick the metric (tokens or billed
 * spend) and the window (daily / monthly / lifetime), then the limit.
 * With `scopeOptions` the form also lets the user choose the scope; without
 * them the scope is fixed to `scopeType` + `scopeId`.
 */
export function BudgetPolicyForm({
  scopeType: fixedScopeType,
  scopeId: fixedScopeId,
  scopeOptions,
  existing = [],
  onSubmit,
  isSaving,
  defaultMetric = "tokens",
  defaultWindowKind,
  variant = "card",
  title = "New budget policy",
}: {
  scopeType?: BudgetScopeType;
  scopeId?: string;
  scopeOptions?: BudgetPolicyFormScopeOptions;
  /** policies that already exist, so the form can flag an update instead of a create */
  existing?: BudgetPolicySummary[];
  onSubmit: (input: BudgetPolicyUpsertInput) => void;
  isSaving?: boolean;
  defaultMetric?: BudgetMetric;
  defaultWindowKind?: BudgetWindowKind;
  variant?: "card" | "plain";
  title?: string;
}) {
  const [scope, setScope] = useState<ScopeChoice>(() => {
    if (fixedScopeType && fixedScopeId) return { scopeType: fixedScopeType, scopeId: fixedScopeId };
    if (scopeOptions?.agents[0]) return { scopeType: "agent", scopeId: scopeOptions.agents[0].id };
    return { scopeType: "company", scopeId: scopeOptions?.company.id ?? "" };
  });
  const [metric, setMetric] = useState<BudgetMetric>(defaultMetric);
  const [windowKind, setWindowKind] = useState<BudgetWindowKind>(
    defaultWindowKind ?? defaultWindowFor(defaultMetric, scope.scopeType),
  );
  const [amountRaw, setAmountRaw] = useState("");
  const [warnPercent, setWarnPercent] = useState("80");
  const [hardStopEnabled, setHardStopEnabled] = useState(true);
  const [notifyEnabled, setNotifyEnabled] = useState(true);

  useEffect(() => {
    if (fixedScopeType && fixedScopeId) setScope({ scopeType: fixedScopeType, scopeId: fixedScopeId });
  }, [fixedScopeType, fixedScopeId]);

  const isTokens = metric === "tokens";
  const parsedAmount = parseBudgetAmountInput(metric, amountRaw);
  const parsedWarn = Number.parseInt(warnPercent, 10);
  const warnValid = Number.isInteger(parsedWarn) && parsedWarn >= 1 && parsedWarn <= 99;
  const scopeValid = scope.scopeId.length > 0;
  const existingMatch = useMemo(
    () =>
      existing.find(
        (policy) =>
          policy.scopeType === scope.scopeType &&
          policy.scopeId === scope.scopeId &&
          policy.metric === metric &&
          policy.windowKind === windowKind,
      ) ?? null,
    [existing, metric, scope.scopeId, scope.scopeType, windowKind],
  );
  const canSubmit = typeof parsedAmount === "number" && parsedAmount > 0 && warnValid && scopeValid && !isSaving;

  const scopeItems = useMemo(() => {
    if (!scopeOptions) return [];
    switch (scope.scopeType) {
      case "agent":
        return scopeOptions.agents;
      case "project":
        return scopeOptions.projects;
      default:
        return [scopeOptions.company];
    }
  }, [scope.scopeType, scopeOptions]);

  const changeScopeType = (next: BudgetScopeType) => {
    if (!scopeOptions) return;
    const first =
      next === "agent" ? scopeOptions.agents[0]?.id : next === "project" ? scopeOptions.projects[0]?.id : scopeOptions.company.id;
    setScope({ scopeType: next, scopeId: first ?? "" });
    if (metric === "billed_cents") setWindowKind(defaultWindowFor(metric, next));
  };

  const changeMetric = (next: BudgetMetric) => {
    setMetric(next);
    setWindowKind(defaultWindowFor(next, scope.scopeType));
    setAmountRaw("");
  };

  const submit = () => {
    if (typeof parsedAmount !== "number" || parsedAmount <= 0 || !warnValid || !scopeValid) return;
    onSubmit({
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      metric,
      windowKind,
      amount: parsedAmount,
      warnPercent: parsedWarn,
      hardStopEnabled,
      notifyEnabled,
      isActive: true,
    });
    setAmountRaw("");
  };

  const fieldLabel = "text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground";

  const body = (
    <div className="space-y-4" data-testid="budget-policy-form">
      {scopeOptions ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label className={fieldLabel}>Scope</Label>
            <Select value={scope.scopeType} onValueChange={(value) => changeScopeType(value as BudgetScopeType)}>
              <SelectTrigger aria-label="Scope type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">Agent</SelectItem>
                <SelectItem value="project">Project</SelectItem>
                <SelectItem value="company">Organization</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className={fieldLabel}>{scope.scopeType === "company" ? "Organization" : scope.scopeType === "agent" ? "Agent" : "Project"}</Label>
            <Select
              value={scope.scopeId}
              onValueChange={(value) => setScope((current) => ({ ...current, scopeId: value }))}
              disabled={scopeItems.length === 0}
            >
              <SelectTrigger aria-label="Scope">
                <SelectValue placeholder={scopeItems.length === 0 ? "Nothing available" : "Select"} />
              </SelectTrigger>
              <SelectContent>
                {scopeItems.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className={fieldLabel}>Metric</Label>
          <Select value={metric} onValueChange={(value) => changeMetric(value as BudgetMetric)}>
            <SelectTrigger aria-label="Budget metric" data-testid="budget-metric-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BUDGET_METRICS.map((value) => (
                <SelectItem key={value} value={value}>
                  {budgetMetricLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{METRIC_HELP[metric]}</p>
        </div>
        <div className="space-y-2">
          <Label className={fieldLabel}>Window</Label>
          <Select value={windowKind} onValueChange={(value) => setWindowKind(value as BudgetWindowKind)}>
            <SelectTrigger aria-label="Budget window" data-testid="budget-window-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BUDGET_WINDOW_KINDS.map((value) => (
                <SelectItem key={value} value={value}>
                  {budgetWindowLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {windowKind === "lifetime"
              ? "Never resets; raise the limit to resume."
              : "Usage resets at 00:00 UTC; paused scopes resume automatically when the window rolls over."}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <div className="space-y-2">
          <Label className={fieldLabel} htmlFor="budget-policy-amount">
            {isTokens ? "Token limit" : "Budget (USD)"}
          </Label>
          <Input
            id="budget-policy-amount"
            value={amountRaw}
            onChange={(event) => setAmountRaw(event.target.value)}
            inputMode={isTokens ? "numeric" : "decimal"}
            placeholder={isTokens ? "20000000" : "0.00"}
          />
          <p className="text-xs text-muted-foreground tabular-nums" data-testid="budget-form-amount-hint">
            {isTokens
              ? tokenAmountHint(parsedAmount)
              : parsedAmount != null && parsedAmount > 0
                ? formatBudgetAmount("billed_cents", parsedAmount)
                : "Dollar amount, e.g. 25.00"}
          </p>
          {parsedAmount === null ? (
            <p className="text-xs text-destructive">{budgetAmountInvalidMessage(metric)}</p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label className={fieldLabel} htmlFor="budget-policy-warn">Warn at %</Label>
          <Input
            id="budget-policy-warn"
            value={warnPercent}
            onChange={(event) => setWarnPercent(event.target.value)}
            inputMode="numeric"
            placeholder="80"
          />
          {!warnValid ? <p className="text-xs text-destructive">1-99</p> : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-5">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={hardStopEnabled} onCheckedChange={(value) => setHardStopEnabled(value === true)} aria-label="Hard stop" />
          Hard stop (pause the scope at the limit)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={notifyEnabled} onCheckedChange={(value) => setNotifyEnabled(value === true)} aria-label="Notify" />
          Notify at the warning threshold
        </label>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {existingMatch
            ? `Replaces the current ${formatBudgetAmount(existingMatch.metric, existingMatch.amount)} limit on this scope.`
            : "One policy per scope, metric and window."}
        </p>
        <Button onClick={submit} disabled={!canSubmit} data-testid="budget-policy-submit">
          {isSaving ? "Saving..." : existingMatch ? "Update policy" : "Create policy"}
        </Button>
      </div>
    </div>
  );

  if (variant === "plain") {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-xs text-muted-foreground">
            Cap billed spend or total tokens per day, month or lifetime.
          </p>
        </div>
        {body}
      </div>
    );
  }

  return (
    <Card className={cn("border-border/70 bg-card/80")}>
      <CardHeader className="px-5 pt-5 pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          Cap billed spend or total tokens per day, month or lifetime. A hard stop pauses the scope until the window rolls over or the limit is raised.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-0">{body}</CardContent>
    </Card>
  );
}
