import { useEffect, useState } from "react";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { AlertTriangle, PauseCircle, ShieldAlert, Wallet } from "lucide-react";
import { cn } from "../lib/utils";
import {
  budgetAmountInputValue,
  budgetAmountInvalidMessage,
  budgetPolicyTitle,
  formatBudgetAmount,
  formatBudgetUsageLine,
  parseBudgetAmountInput,
  tokenAmountHint,
} from "../lib/budget-format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function statusTone(status: BudgetPolicySummary["status"]) {
  if (status === "hard_stop") return "text-red-700 dark:text-red-300 border-red-500/30 bg-red-500/10";
  if (status === "warning") return "text-amber-700 dark:text-amber-200 border-amber-500/30 bg-amber-500/10";
  return "text-emerald-700 dark:text-emerald-200 border-emerald-500/30 bg-emerald-500/10";
}

/**
 * One budget policy (billed cents or tokens, over a daily / monthly / lifetime
 * window) with its current-window usage and an inline limit editor.
 * `onSave` receives the amount in the policy's own metric unit.
 */
export function BudgetPolicyCard({
  summary,
  onSave,
  isSaving,
  compact = false,
  variant = "card",
}: {
  summary: BudgetPolicySummary;
  onSave?: (amount: number) => void;
  isSaving?: boolean;
  compact?: boolean;
  variant?: "card" | "plain";
}) {
  const isTokens = summary.metric === "tokens";
  const [draftBudget, setDraftBudget] = useState(budgetAmountInputValue(summary.metric, summary.amount));

  useEffect(() => {
    setDraftBudget(budgetAmountInputValue(summary.metric, summary.amount));
  }, [summary.amount, summary.metric]);

  const parsedDraft = parseBudgetAmountInput(summary.metric, draftBudget);
  const canSave = typeof parsedDraft === "number" && parsedDraft !== summary.amount && Boolean(onSave);
  const progress = summary.amount > 0 ? Math.min(100, summary.utilizationPercent) : 0;
  const StatusIcon = summary.status === "hard_stop" ? ShieldAlert : summary.status === "warning" ? AlertTriangle : Wallet;
  const isPlain = variant === "plain";
  const usageLine = formatBudgetUsageLine(summary);
  const title = budgetPolicyTitle(summary.metric, summary.windowKind);

  const observedCell = (
    <>
      <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">Observed</div>
      <div className="mt-2 text-xl font-semibold tabular-nums">{formatBudgetAmount(summary.metric, summary.observedAmount)}</div>
      <div className="mt-1 text-xs text-muted-foreground" data-testid="budget-usage-line">
        {summary.amount > 0 ? usageLine : "No cap configured"}
      </div>
    </>
  );
  const budgetCell = (
    <>
      <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
        {isTokens ? "Token limit" : "Budget"}
      </div>
      <div className="mt-2 text-xl font-semibold tabular-nums">
        {summary.amount > 0 ? formatBudgetAmount(summary.metric, summary.amount) : "Disabled"}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        Soft alert at {summary.warnPercent}%
        {summary.hardStopEnabled ? " · hard stop" : " · no hard stop"}
        {summary.paused && summary.pauseReason ? ` · ${summary.pauseReason} pause` : ""}
      </div>
    </>
  );

  const observedBudgetGrid = isPlain ? (
    <div className="grid gap-6 sm:grid-cols-2">
      <div>{observedCell}</div>
      <div>{budgetCell}</div>
    </div>
  ) : (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-border/70 bg-black/[0.18] px-4 py-3">{observedCell}</div>
      <div className="rounded-xl border border-border/70 bg-black/[0.18] px-4 py-3">{budgetCell}</div>
    </div>
  );

  const progressSection = (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Remaining</span>
        <span>{summary.amount > 0 ? formatBudgetAmount(summary.metric, summary.remainingAmount) : "Unlimited"}</span>
      </div>
      <div className={cn("h-2 overflow-hidden rounded-full", isPlain ? "bg-border/70" : "bg-muted/70")}>
        <div
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Budget utilization: ${Math.round(progress)}% used`}
          className={cn(
            "h-full rounded-full transition-(--tp-width-background-color) duration-200",
            summary.status === "hard_stop"
              ? "bg-(--status-task-blocked)"
              : summary.status === "warning"
                ? "bg-(--status-task-todo)"
                : "bg-(--status-task-done)",
          )}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );

  const pausedPane = summary.paused ? (
    <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-900 dark:text-red-100">
      <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        {summary.scopeType === "project"
          ? "Execution is paused for this project until the budget is raised, the incident is dismissed, or the window rolls over."
          : "Heartbeats are paused for this scope until the budget is raised, the incident is dismissed, or the window rolls over."}
      </div>
    </div>
  ) : null;

  const saveSection = onSave ? (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-end", isPlain ? "" : "rounded-xl border border-border/70 bg-background/50 p-3")}>
      <div className="min-w-0 flex-1">
        <label className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
          {isTokens ? "Token limit" : "Budget (USD)"}
        </label>
        <Input
          value={draftBudget}
          onChange={(event) => setDraftBudget(event.target.value)}
          className="mt-2"
          inputMode={isTokens ? "numeric" : "decimal"}
          placeholder={isTokens ? "20000000" : "0.00"}
          aria-label={isTokens ? "Token limit" : "Budget in US dollars"}
        />
        {isTokens ? (
          <p className="mt-1 text-xs text-muted-foreground tabular-nums" data-testid="budget-token-hint">
            {tokenAmountHint(parsedDraft)}
          </p>
        ) : null}
      </div>
      <Button
        onClick={() => {
          if (typeof parsedDraft === "number" && onSave) onSave(parsedDraft);
        }}
        disabled={!canSave || isSaving || parsedDraft === null}
      >
        {isSaving ? "Saving..." : summary.amount > 0 ? (isTokens ? "Update limit" : "Update budget") : (isTokens ? "Set limit" : "Set budget")}
      </Button>
    </div>
  ) : null;

  const invalidMessage = parsedDraft === null ? (
    <p className="text-xs text-destructive">{budgetAmountInvalidMessage(summary.metric)}</p>
  ) : null;

  const statusLabel = summary.paused ? "Paused" : summary.status === "warning" ? "Warning" : summary.status === "hard_stop" ? "Hard stop" : "Healthy";

  if (isPlain) {
    return (
      <div className="space-y-6" data-testid={`budget-policy-${summary.metric}-${summary.windowKind}`}>
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
              {summary.scopeType}
            </div>
            <div className="mt-2 text-xl font-semibold">{summary.scopeName}</div>
            <div className="mt-2 text-sm text-muted-foreground">{title}</div>
          </div>
          <div
            className={cn(
              "inline-flex items-center gap-2 text-(length:--text-micro) uppercase tracking-(--tracking-caps)",
              summary.status === "hard_stop"
                ? "text-red-700 dark:text-red-300"
                : summary.status === "warning"
                  ? "text-amber-800 dark:text-amber-200"
                  : "text-muted-foreground",
            )}
          >
            <StatusIcon className="h-3.5 w-3.5" />
            {statusLabel}
          </div>
        </div>

        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {invalidMessage}
      </div>
    );
  }

  return (
    <Card
      className={cn("overflow-hidden border-border/70 bg-card/80", compact ? "" : "shadow-(--shadow-extract-2)")}
      data-testid={`budget-policy-${summary.metric}-${summary.windowKind}`}
    >
      <CardHeader className={cn("gap-3", compact ? "px-4 pt-4 pb-2" : "px-5 pt-5 pb-3")}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
              {summary.scopeType}
            </div>
            <CardTitle className="mt-1 text-base">{summary.scopeName}</CardTitle>
            <CardDescription className="mt-1">{title}</CardDescription>
          </div>
          <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-(length:--text-micro) uppercase tracking-(--tracking-caps)", statusTone(summary.status))}>
            <StatusIcon className="h-3.5 w-3.5" />
            {statusLabel}
          </div>
        </div>
      </CardHeader>
      <CardContent className={cn("space-y-4", compact ? "px-4 pb-4 pt-0" : "px-5 pb-5 pt-0")}>
        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {invalidMessage}
      </CardContent>
    </Card>
  );
}
