import { and, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  projects,
} from "@paperclipai/db";
import {
  BUDGET_METRICS,
  type BudgetIncident,
  type BudgetIncidentResolutionInput,
  type BudgetMetric,
  type BudgetOverview,
  type PauseReason,
  type BudgetPolicy,
  type BudgetPolicySummary,
  type BudgetPolicyUpsertInput,
  type BudgetScopeType,
  type BudgetThresholdType,
  type BudgetWindowKind,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

type ScopeRecord = {
  companyId: string;
  name: string;
  paused: boolean;
  pauseReason: PauseReason | null;
};

type PolicyRow = typeof budgetPolicies.$inferSelect;
type IncidentRow = typeof budgetIncidents.$inferSelect;

export type BudgetEnforcementScope = {
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
};

export type BudgetServiceHooks = {
  cancelWorkForScope?: (scope: BudgetEnforcementScope) => Promise<void>;
  /** Clock override for tests; windows and rollovers are evaluated against it. */
  now?: () => Date;
};

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

function currentUtcDayWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** The [start, end) window a policy of this kind is evaluated over at `now`. */
export function resolveBudgetWindow(windowKind: BudgetWindowKind, now = new Date()) {
  if (windowKind === "lifetime") {
    return {
      start: new Date(Date.UTC(1970, 0, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(9999, 0, 1, 0, 0, 0, 0)),
    };
  }
  if (windowKind === "calendar_day_utc") return currentUtcDayWindow(now);
  return currentUtcMonthWindow(now);
}

function isKnownMetric(metric: string): metric is BudgetMetric {
  return (BUDGET_METRICS as readonly string[]).includes(metric);
}

function budgetStatusFromObserved(
  observedAmount: number,
  amount: number,
  warnPercent: number,
): BudgetPolicySummary["status"] {
  if (amount <= 0) return "ok";
  if (observedAmount >= amount) return "hard_stop";
  if (observedAmount >= Math.ceil((amount * warnPercent) / 100)) return "warning";
  return "ok";
}

function normalizeScopeName(scopeType: BudgetScopeType, name: string) {
  if (scopeType === "company") return name;
  return name.trim().length > 0 ? name : scopeType;
}

async function resolveScopeRecord(db: Db, scopeType: BudgetScopeType, scopeId: string): Promise<ScopeRecord> {
  if (scopeType === "company") {
    const row = await db
      .select({
        companyId: companies.id,
        name: companies.name,
        status: companies.status,
        pauseReason: companies.pauseReason,
        pausedAt: companies.pausedAt,
      })
      .from(companies)
      .where(eq(companies.id, scopeId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Company not found");
    return {
      companyId: row.companyId,
      name: row.name,
      paused: row.status === "paused" || Boolean(row.pausedAt),
      pauseReason: (row.pauseReason as ScopeRecord["pauseReason"]) ?? null,
    };
  }

  if (scopeType === "agent") {
    const row = await db
      .select({
        companyId: agents.companyId,
        name: agents.name,
        status: agents.status,
        pauseReason: agents.pauseReason,
      })
      .from(agents)
      .where(eq(agents.id, scopeId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Agent not found");
    return {
      companyId: row.companyId,
      name: row.name,
      paused: row.status === "paused",
      pauseReason: (row.pauseReason as ScopeRecord["pauseReason"]) ?? null,
    };
  }

  const row = await db
    .select({
      companyId: projects.companyId,
      name: projects.name,
      pauseReason: projects.pauseReason,
      pausedAt: projects.pausedAt,
    })
    .from(projects)
    .where(eq(projects.id, scopeId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Project not found");
  return {
    companyId: row.companyId,
    name: row.name,
    paused: Boolean(row.pausedAt),
    pauseReason: (row.pauseReason as ScopeRecord["pauseReason"]) ?? null,
  };
}

/**
 * Sum the metric of a policy over its scope and current window.
 * `billed_cents` sums cost_cents; `tokens` sums input + cached input + output
 * tokens across every provider. Sums are cast to double precision so bigint
 * totals arrive as JS numbers (exact below 2^53) instead of strings.
 */
export async function computeBudgetObservedAmount(
  db: Db,
  policy: Pick<PolicyRow, "companyId" | "scopeType" | "scopeId" | "windowKind" | "metric">,
  now = new Date(),
) {
  if (!isKnownMetric(policy.metric)) return 0;

  const conditions = [eq(costEvents.companyId, policy.companyId)];
  if (policy.scopeType === "agent") conditions.push(eq(costEvents.agentId, policy.scopeId));
  if (policy.scopeType === "project") conditions.push(eq(costEvents.projectId, policy.scopeId));
  const { start, end } = resolveBudgetWindow(policy.windowKind as BudgetWindowKind, now);
  if (policy.windowKind !== "lifetime") {
    conditions.push(gte(costEvents.occurredAt, start));
    conditions.push(lt(costEvents.occurredAt, end));
  }

  // The per-row addition is widened to bigint first: three int4 columns of a
  // single large event would overflow int4 before sum() ever sees them.
  const total = policy.metric === "tokens"
    ? sql<number>`coalesce(sum(${costEvents.inputTokens}::bigint + ${costEvents.cachedInputTokens}::bigint + ${costEvents.outputTokens}::bigint), 0)::double precision`
    : sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`;

  const [row] = await db
    .select({ total })
    .from(costEvents)
    .where(and(...conditions));

  return Number(row?.total ?? 0);
}

/** True when this policy is an active hard stop the scope can still trip. */
function isEnforceableHardStop(policy: Pick<PolicyRow, "isActive" | "hardStopEnabled" | "amount" | "metric">) {
  return policy.isActive && policy.hardStopEnabled && policy.amount > 0 && isKnownMetric(policy.metric);
}

function buildApprovalPayload(input: {
  policy: PolicyRow;
  scopeName: string;
  thresholdType: BudgetThresholdType;
  amountObserved: number;
  windowStart: Date;
  windowEnd: Date;
}) {
  return {
    scopeType: input.policy.scopeType,
    scopeId: input.policy.scopeId,
    scopeName: input.scopeName,
    metric: input.policy.metric,
    windowKind: input.policy.windowKind,
    thresholdType: input.thresholdType,
    budgetAmount: input.policy.amount,
    observedAmount: input.amountObserved,
    warnPercent: input.policy.warnPercent,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    policyId: input.policy.id,
    guidance: "Raise the budget and resume the scope, or keep the scope paused.",
  };
}

async function markApprovalStatus(
  db: Db,
  approvalId: string | null,
  status: "approved" | "rejected",
  decisionNote: string | null | undefined,
  decidedByUserId: string,
) {
  if (!approvalId) return;
  await db
    .update(approvals)
    .set({
      status,
      decisionNote: decisionNote ?? null,
      decidedByUserId,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(approvals.id, approvalId));
}

export function budgetService(db: Db, hooks: BudgetServiceHooks = {}) {
  const now = hooks.now ?? (() => new Date());
  const computeObservedAmount = (
    policy: Pick<PolicyRow, "companyId" | "scopeType" | "scopeId" | "windowKind" | "metric">,
  ) => computeBudgetObservedAmount(db, policy, now());
  const resolveWindow = (windowKind: BudgetWindowKind) => resolveBudgetWindow(windowKind, now());

  async function pauseScopeForBudget(policy: PolicyRow) {
    const now = new Date();
    if (policy.scopeType === "agent") {
      await db
        .update(agents)
        .set({
          status: "paused",
          pauseReason: "budget",
          pausedAt: now,
          updatedAt: now,
        })
        .where(and(eq(agents.id, policy.scopeId), inArray(agents.status, ["active", "idle", "running", "error"])));
      return;
    }

    if (policy.scopeType === "project") {
      await db
        .update(projects)
        .set({
          pauseReason: "budget",
          pausedAt: now,
          updatedAt: now,
        })
        .where(eq(projects.id, policy.scopeId));
      return;
    }

    await db
      .update(companies)
      .set({
        status: "paused",
        pauseReason: "budget",
        pausedAt: now,
        updatedAt: now,
      })
      .where(eq(companies.id, policy.scopeId));
  }

  async function pauseAndCancelScopeForBudget(policy: PolicyRow) {
    await pauseScopeForBudget(policy);
    await hooks.cancelWorkForScope?.({
      companyId: policy.companyId,
      scopeType: policy.scopeType as BudgetScopeType,
      scopeId: policy.scopeId,
    });
  }

  async function resumeScopeFromBudget(policy: PolicyRow) {
    const now = new Date();
    if (policy.scopeType === "agent") {
      await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          updatedAt: now,
        })
        .where(and(eq(agents.id, policy.scopeId), eq(agents.pauseReason, "budget")));
      return;
    }

    if (policy.scopeType === "project") {
      await db
        .update(projects)
        .set({
          pauseReason: null,
          pausedAt: null,
          updatedAt: now,
        })
        .where(and(eq(projects.id, policy.scopeId), eq(projects.pauseReason, "budget")));
      return;
    }

    await db
      .update(companies)
      .set({
        status: "active",
        pauseReason: null,
        pausedAt: null,
        updatedAt: now,
      })
      .where(and(eq(companies.id, policy.scopeId), eq(companies.pauseReason, "budget")));
  }

  async function getPolicyRow(policyId: string) {
    const policy = await db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.id, policyId))
      .then((rows) => rows[0] ?? null);
    if (!policy) throw notFound("Budget policy not found");
    return policy;
  }

  async function listPolicyRows(companyId: string) {
    return db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.companyId, companyId))
      .orderBy(desc(budgetPolicies.updatedAt));
  }

  async function buildPolicySummary(policy: PolicyRow): Promise<BudgetPolicySummary> {
    const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId);
    const observedAmount = await computeObservedAmount(policy);
    const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
    const amount = policy.isActive ? policy.amount : 0;
    const utilizationPercent =
      amount > 0 ? Number(((observedAmount / amount) * 100).toFixed(2)) : 0;
    return {
      policyId: policy.id,
      companyId: policy.companyId,
      scopeType: policy.scopeType as BudgetScopeType,
      scopeId: policy.scopeId,
      scopeName: normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
      metric: policy.metric as BudgetMetric,
      windowKind: policy.windowKind as BudgetWindowKind,
      amount,
      observedAmount,
      remainingAmount: amount > 0 ? Math.max(0, amount - observedAmount) : 0,
      utilizationPercent,
      warnPercent: policy.warnPercent,
      hardStopEnabled: policy.hardStopEnabled,
      notifyEnabled: policy.notifyEnabled,
      isActive: policy.isActive,
      status: policy.isActive
        ? budgetStatusFromObserved(observedAmount, amount, policy.warnPercent)
        : "ok",
      paused: scope.paused,
      pauseReason: scope.pauseReason,
      windowStart: start,
      windowEnd: end,
    };
  }

  async function createIncidentIfNeeded(
    policy: PolicyRow,
    thresholdType: BudgetThresholdType,
    amountObserved: number,
  ) {
    const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
    const existing = await db
      .select()
      .from(budgetIncidents)
      .where(
        and(
          eq(budgetIncidents.policyId, policy.id),
          eq(budgetIncidents.windowStart, start),
          eq(budgetIncidents.thresholdType, thresholdType),
          ne(budgetIncidents.status, "dismissed"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) return { incident: existing, created: false };

    const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId);
    const payload = buildApprovalPayload({
      policy,
      scopeName: normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
      thresholdType,
      amountObserved,
      windowStart: start,
      windowEnd: end,
    });

    const approval = thresholdType === "hard"
      ? await db
        .insert(approvals)
        .values({
          companyId: policy.companyId,
          type: "budget_override_required",
          requestedByUserId: null,
          requestedByAgentId: null,
          status: "pending",
          payload,
        })
        .returning()
        .then((rows) => rows[0] ?? null)
      : null;

    const incident = await db
      .insert(budgetIncidents)
      .values({
        companyId: policy.companyId,
        policyId: policy.id,
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        metric: policy.metric,
        windowKind: policy.windowKind,
        windowStart: start,
        windowEnd: end,
        thresholdType,
        amountLimit: policy.amount,
        amountObserved,
        status: "open",
        approvalId: approval?.id ?? null,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    return incident ? { incident, created: true } : null;
  }

  async function resolveOpenSoftIncidents(policyId: string) {
    await db
      .update(budgetIncidents)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(budgetIncidents.policyId, policyId),
          eq(budgetIncidents.thresholdType, "soft"),
          eq(budgetIncidents.status, "open"),
        ),
      );
  }

  async function resolveOpenIncidentsForPolicy(
    policyId: string,
    approvalStatus: "approved" | "rejected" | null,
    decidedByUserId: string | null,
  ) {
    const openRows = await db
      .select()
      .from(budgetIncidents)
      .where(and(eq(budgetIncidents.policyId, policyId), eq(budgetIncidents.status, "open")));

    await db
      .update(budgetIncidents)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(budgetIncidents.policyId, policyId), eq(budgetIncidents.status, "open")));

    if (!approvalStatus || !decidedByUserId) return;
    for (const row of openRows) {
      await markApprovalStatus(db, row.approvalId ?? null, approvalStatus, "Resolved via budget update", decidedByUserId);
    }
  }

  async function listActivePoliciesForScope(companyId: string, scopeType: BudgetScopeType, scopeId: string) {
    return db
      .select()
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeType, scopeType),
          eq(budgetPolicies.scopeId, scopeId),
          eq(budgetPolicies.isActive, true),
        ),
      );
  }

  /**
   * Whether any active hard-stop policy on the scope (any metric, any window)
   * is at or over its limit in its current window.
   */
  async function anyHardStopExceeded(companyId: string, scopeType: BudgetScopeType, scopeId: string) {
    const policies = await listActivePoliciesForScope(companyId, scopeType, scopeId);
    for (const policy of policies) {
      if (!isEnforceableHardStop(policy)) continue;
      const observed = await computeObservedAmount(policy);
      if (observed >= policy.amount) return true;
    }
    return false;
  }

  /**
   * Resume scopes whose budget pause has expired with its window.
   *
   * A hard stop pauses the scope and leaves it paused; nothing in the cost
   * pipeline runs for a paused scope, so the pause would otherwise outlive the
   * window that caused it (a daily token cap would keep the agent down for
   * good). This sweep looks at every scope currently paused with
   * pauseReason "budget", re-evaluates all of its active hard-stop policies
   * against their *current* windows (a new UTC day or month), and when none is
   * still exceeded it resumes the scope and resolves the open incidents of
   * those policies. Lifetime windows never roll over, and a scope that is
   * still over any of its limits stays paused. Manual pauses (other pause
   * reasons) are never touched. Approvals attached to the resolved incidents
   * are left as they are; the incident row records the resolution. Wired as a
   * periodic execution-control sweep in server/src/index.ts.
   */
  async function reconcileWindowRollovers(): Promise<{ resumed: BudgetEnforcementScope[] }> {
    const pausedAgents = await db
      .select({ companyId: agents.companyId, scopeId: agents.id })
      .from(agents)
      .where(and(eq(agents.status, "paused"), eq(agents.pauseReason, "budget")));
    const pausedProjects = await db
      .select({ companyId: projects.companyId, scopeId: projects.id })
      .from(projects)
      .where(and(isNotNull(projects.pausedAt), eq(projects.pauseReason, "budget")));
    const pausedCompanies = await db
      .select({ companyId: companies.id, scopeId: companies.id })
      .from(companies)
      .where(and(eq(companies.status, "paused"), eq(companies.pauseReason, "budget")));

    const candidates: BudgetEnforcementScope[] = [
      ...pausedAgents.map((row) => ({ companyId: row.companyId, scopeType: "agent" as const, scopeId: row.scopeId })),
      ...pausedProjects.map((row) => ({ companyId: row.companyId, scopeType: "project" as const, scopeId: row.scopeId })),
      ...pausedCompanies.map((row) => ({ companyId: row.companyId, scopeType: "company" as const, scopeId: row.scopeId })),
    ];

    const resumed: BudgetEnforcementScope[] = [];
    for (const scope of candidates) {
      const policies = await listActivePoliciesForScope(scope.companyId, scope.scopeType, scope.scopeId);
      const hardStops = policies.filter(isEnforceableHardStop);

      let stillExceeded = false;
      for (const policy of hardStops) {
        const observed = await computeObservedAmount(policy);
        if (observed >= policy.amount) {
          stillExceeded = true;
          break;
        }
      }
      if (stillExceeded) continue;

      // No enforceable policy holds the scope any more (its window rolled over
      // or every policy was deactivated): lift the pause.
      await resumeScopeFromBudget({ scopeType: scope.scopeType, scopeId: scope.scopeId } as PolicyRow);
      for (const policy of policies) await resolveOpenIncidentsForPolicy(policy.id, null, null);
      await logActivity(db, {
        companyId: scope.companyId,
        actorType: "system",
        actorId: "budget_service",
        action: "budget.window_rolled_over",
        entityType: scope.scopeType,
        entityId: scope.scopeId,
        details: {
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          policyIds: hardStops.map((policy) => policy.id),
        },
      });
      resumed.push(scope);
    }
    return { resumed };
  }

  async function hydrateIncidentRows(rows: IncidentRow[]): Promise<BudgetIncident[]> {
    const approvalIds = rows.map((row) => row.approvalId).filter((value): value is string => Boolean(value));
    const approvalRows = approvalIds.length > 0
      ? await db
        .select({ id: approvals.id, status: approvals.status })
        .from(approvals)
        .where(inArray(approvals.id, approvalIds))
      : [];
    const approvalStatusById = new Map(approvalRows.map((row) => [row.id, row.status]));

    return Promise.all(
      rows.map(async (row) => {
        const scope = await resolveScopeRecord(db, row.scopeType as BudgetScopeType, row.scopeId);
        return {
          id: row.id,
          companyId: row.companyId,
          policyId: row.policyId,
          scopeType: row.scopeType as BudgetScopeType,
          scopeId: row.scopeId,
          scopeName: normalizeScopeName(row.scopeType as BudgetScopeType, scope.name),
          metric: row.metric as BudgetMetric,
          windowKind: row.windowKind as BudgetWindowKind,
          windowStart: row.windowStart,
          windowEnd: row.windowEnd,
          thresholdType: row.thresholdType as BudgetThresholdType,
          amountLimit: row.amountLimit,
          amountObserved: row.amountObserved,
          status: row.status as BudgetIncident["status"],
          approvalId: row.approvalId ?? null,
          approvalStatus: row.approvalId ? approvalStatusById.get(row.approvalId) ?? null : null,
          resolvedAt: row.resolvedAt ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }),
    );
  }

  return {
    listPolicies: async (companyId: string): Promise<BudgetPolicy[]> => {
      const rows = await listPolicyRows(companyId);
      return rows.map((row) => ({
        ...row,
        scopeType: row.scopeType as BudgetScopeType,
        metric: row.metric as BudgetMetric,
        windowKind: row.windowKind as BudgetWindowKind,
      }));
    },

    upsertPolicy: async (
      companyId: string,
      input: BudgetPolicyUpsertInput,
      actorUserId: string | null,
    ): Promise<BudgetPolicySummary> => {
      const scope = await resolveScopeRecord(db, input.scopeType, input.scopeId);
      if (scope.companyId !== companyId) {
        throw unprocessable("Budget scope does not belong to company");
      }

      const metric = input.metric ?? "billed_cents";
      const windowKind = input.windowKind ?? (input.scopeType === "project" ? "lifetime" : "calendar_month_utc");
      const amount = Math.max(0, Math.floor(input.amount));
      const nextIsActive = amount > 0 && (input.isActive ?? true);
      const existing = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, input.scopeType),
            eq(budgetPolicies.scopeId, input.scopeId),
            eq(budgetPolicies.metric, metric),
            eq(budgetPolicies.windowKind, windowKind),
          ),
        )
        .then((rows) => rows[0] ?? null);

      const now = new Date();
      const row = existing
        ? await db
          .update(budgetPolicies)
          .set({
            amount,
            warnPercent: input.warnPercent ?? existing.warnPercent,
            hardStopEnabled: input.hardStopEnabled ?? existing.hardStopEnabled,
            notifyEnabled: input.notifyEnabled ?? existing.notifyEnabled,
            isActive: nextIsActive,
            updatedByUserId: actorUserId,
            updatedAt: now,
          })
          .where(eq(budgetPolicies.id, existing.id))
          .returning()
          .then((rows) => rows[0])
        : await db
          .insert(budgetPolicies)
          .values({
            companyId,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            metric,
            windowKind,
            amount,
            warnPercent: input.warnPercent ?? 80,
            hardStopEnabled: input.hardStopEnabled ?? true,
            notifyEnabled: input.notifyEnabled ?? true,
            isActive: nextIsActive,
            createdByUserId: actorUserId,
            updatedByUserId: actorUserId,
          })
          .returning()
          .then((rows) => rows[0]);

      // companies/agents.budget_monthly_cents mirrors only the monthly dollar policy.
      if (input.scopeType === "company" && windowKind === "calendar_month_utc" && metric === "billed_cents") {
        await db
          .update(companies)
          .set({
            budgetMonthlyCents: amount,
            updatedAt: now,
          })
          .where(eq(companies.id, input.scopeId));
      }

      if (input.scopeType === "agent" && windowKind === "calendar_month_utc" && metric === "billed_cents") {
        await db
          .update(agents)
          .set({
            budgetMonthlyCents: amount,
            updatedAt: now,
          })
          .where(eq(agents.id, input.scopeId));
      }

      if (amount > 0) {
        const observedAmount = await computeObservedAmount(row);
        if (observedAmount < amount) {
          await resumeScopeFromBudget(row);
          await resolveOpenIncidentsForPolicy(row.id, actorUserId ? "approved" : null, actorUserId);
        } else {
          const softThreshold = Math.ceil((row.amount * row.warnPercent) / 100);
          if (row.notifyEnabled && observedAmount >= softThreshold) {
            await createIncidentIfNeeded(row, "soft", observedAmount);
          }
          if (row.hardStopEnabled && observedAmount >= row.amount) {
            await resolveOpenSoftIncidents(row.id);
            await createIncidentIfNeeded(row, "hard", observedAmount);
            await pauseAndCancelScopeForBudget(row);
          }
        }
      } else {
        await resumeScopeFromBudget(row);
        await resolveOpenIncidentsForPolicy(row.id, actorUserId ? "approved" : null, actorUserId);
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "budget.policy_upserted",
        entityType: "budget_policy",
        entityId: row.id,
        details: {
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          amount: row.amount,
          metric: row.metric,
          windowKind: row.windowKind,
        },
      });

      return buildPolicySummary(row);
    },

    overview: async (companyId: string): Promise<BudgetOverview> => {
      const rows = await listPolicyRows(companyId);
      const policies = await Promise.all(rows.map((row) => buildPolicySummary(row)));
      const activeIncidentRows = await db
        .select()
        .from(budgetIncidents)
        .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.status, "open")))
        .orderBy(desc(budgetIncidents.createdAt));
      const activeIncidents = await hydrateIncidentRows(activeIncidentRows);
      return {
        companyId,
        policies,
        activeIncidents,
        pausedAgentCount: policies.filter((policy) => policy.scopeType === "agent" && policy.paused).length,
        pausedProjectCount: policies.filter((policy) => policy.scopeType === "project" && policy.paused).length,
        pendingApprovalCount: activeIncidents.filter((incident) => incident.approvalStatus === "pending").length,
      };
    },

    evaluateCostEvent: async (event: typeof costEvents.$inferSelect) => {
      const candidatePolicies = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, event.companyId),
            eq(budgetPolicies.isActive, true),
            inArray(budgetPolicies.scopeType, ["company", "agent", "project"]),
          ),
        );

      const relevantPolicies = candidatePolicies.filter((policy) => {
        if (policy.scopeType === "company") return policy.scopeId === event.companyId;
        if (policy.scopeType === "agent") return policy.scopeId === event.agentId;
        if (policy.scopeType === "project") return Boolean(event.projectId) && policy.scopeId === event.projectId;
        return false;
      });

      for (const policy of relevantPolicies) {
        if (!isKnownMetric(policy.metric) || policy.amount <= 0) continue;
        const observedAmount = await computeObservedAmount(policy);
        const softThreshold = Math.ceil((policy.amount * policy.warnPercent) / 100);

        if (policy.notifyEnabled && observedAmount >= softThreshold) {
          const softIncident = await createIncidentIfNeeded(policy, "soft", observedAmount);
          if (softIncident?.created) {
            await logActivity(db, {
              companyId: policy.companyId,
              actorType: "system",
              actorId: "budget_service",
              action: "budget.soft_threshold_crossed",
              entityType: "budget_incident",
              entityId: softIncident.incident.id,
              details: {
                scopeType: policy.scopeType,
                scopeId: policy.scopeId,
                amountObserved: observedAmount,
                amountLimit: policy.amount,
              },
            });
          }
        }

        if (policy.hardStopEnabled && observedAmount >= policy.amount) {
          await resolveOpenSoftIncidents(policy.id);
          const hardIncident = await createIncidentIfNeeded(policy, "hard", observedAmount);
          await pauseAndCancelScopeForBudget(policy);
          if (hardIncident?.created) {
            await logActivity(db, {
              companyId: policy.companyId,
              actorType: "system",
              actorId: "budget_service",
              action: "budget.hard_threshold_crossed",
              entityType: "budget_incident",
              entityId: hardIncident.incident.id,
              details: {
                scopeType: policy.scopeType,
                scopeId: policy.scopeId,
                amountObserved: observedAmount,
                amountLimit: policy.amount,
                approvalId: hardIncident.incident.approvalId ?? null,
              },
            });
          }
        }
      }
    },

    reconcileWindowRollovers,

    getInvocationBlock: async (
      companyId: string,
      agentId: string,
      context?: { issueId?: string | null; projectId?: string | null },
    ) => {
      const agent = await db
        .select({
          status: agents.status,
          pauseReason: agents.pauseReason,
          companyId: agents.companyId,
          name: agents.name,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");

      const company = await db
        .select({
          status: companies.status,
          pauseReason: companies.pauseReason,
          name: companies.name,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");
      if (company.status === "paused") {
        return {
          scopeType: "company" as const,
          scopeId: companyId,
          scopeName: company.name,
          reason:
            company.pauseReason === "budget"
              ? "Company is paused because its budget hard-stop was reached."
              : "Company is paused and cannot start new work.",
        };
      }

      if (await anyHardStopExceeded(companyId, "company", companyId)) {
        return {
          scopeType: "company" as const,
          scopeId: companyId,
          scopeName: company.name,
          reason: "Company cannot start new work because its budget hard-stop is exceeded.",
        };
      }

      if (agent.status === "paused" && agent.pauseReason === "budget") {
        return {
          scopeType: "agent" as const,
          scopeId: agentId,
          scopeName: agent.name,
          reason: "Agent is paused because its budget hard-stop was reached.",
        };
      }

      if (await anyHardStopExceeded(companyId, "agent", agentId)) {
        return {
          scopeType: "agent" as const,
          scopeId: agentId,
          scopeName: agent.name,
          reason: "Agent cannot start because its budget hard-stop is still exceeded.",
        };
      }

      const candidateProjectId = context?.projectId ?? null;
      if (!candidateProjectId) return null;

      const project = await db
        .select({
          id: projects.id,
          name: projects.name,
          companyId: projects.companyId,
          pauseReason: projects.pauseReason,
          pausedAt: projects.pausedAt,
        })
        .from(projects)
        .where(eq(projects.id, candidateProjectId))
        .then((rows) => rows[0] ?? null);

      if (!project || project.companyId !== companyId) return null;
      if (await anyHardStopExceeded(companyId, "project", project.id)) {
        return {
          scopeType: "project" as const,
          scopeId: project.id,
          scopeName: project.name,
          reason: "Project cannot start work because its budget hard-stop is still exceeded.",
        };
      }

      if (!project.pausedAt || project.pauseReason !== "budget") return null;
      return {
        scopeType: "project" as const,
        scopeId: project.id,
        scopeName: project.name,
        reason: "Project is paused because its budget hard-stop was reached.",
      };
    },

    resolveIncident: async (
      companyId: string,
      incidentId: string,
      input: BudgetIncidentResolutionInput,
      actorUserId: string,
    ): Promise<BudgetIncident> => {
      const incident = await db
        .select()
        .from(budgetIncidents)
        .where(eq(budgetIncidents.id, incidentId))
        .then((rows) => rows[0] ?? null);
      if (!incident) throw notFound("Budget incident not found");
      if (incident.companyId !== companyId) throw notFound("Budget incident not found");

      const policy = await getPolicyRow(incident.policyId);
      if (input.action === "raise_budget_and_resume") {
        const nextAmount = Math.max(0, Math.floor(input.amount ?? 0));
        const currentObserved = await computeObservedAmount(policy);
        if (nextAmount <= currentObserved) {
          throw unprocessable("New budget must exceed current observed spend");
        }

        const now = new Date();
        await db
          .update(budgetPolicies)
          .set({
            amount: nextAmount,
            isActive: true,
            updatedByUserId: actorUserId,
            updatedAt: now,
          })
          .where(eq(budgetPolicies.id, policy.id));

        if (policy.scopeType === "company" && policy.windowKind === "calendar_month_utc" && policy.metric === "billed_cents") {
          await db
            .update(companies)
            .set({ budgetMonthlyCents: nextAmount, updatedAt: now })
            .where(eq(companies.id, policy.scopeId));
        }

        if (policy.scopeType === "agent" && policy.windowKind === "calendar_month_utc" && policy.metric === "billed_cents") {
          await db
            .update(agents)
            .set({ budgetMonthlyCents: nextAmount, updatedAt: now })
            .where(eq(agents.id, policy.scopeId));
        }

        await resumeScopeFromBudget(policy);
        await db
          .update(budgetIncidents)
          .set({
            status: "resolved",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(eq(budgetIncidents.policyId, policy.id), eq(budgetIncidents.status, "open")));

        await markApprovalStatus(db, incident.approvalId ?? null, "approved", input.decisionNote, actorUserId);
      } else {
        await db
          .update(budgetIncidents)
          .set({
            status: "dismissed",
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(budgetIncidents.id, incident.id));
        await markApprovalStatus(db, incident.approvalId ?? null, "rejected", input.decisionNote, actorUserId);
      }

      await logActivity(db, {
        companyId: incident.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "budget.incident_resolved",
        entityType: "budget_incident",
        entityId: incident.id,
        details: {
          action: input.action,
          amount: input.amount ?? null,
          scopeType: incident.scopeType,
          scopeId: incident.scopeId,
        },
      });

      const [updated] = await hydrateIncidentRows([{
        ...incident,
        status: input.action === "raise_budget_and_resume" ? "resolved" : "dismissed",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      }]);
      return updated!;
    },
  };
}
