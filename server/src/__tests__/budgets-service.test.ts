import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  projects,
} from "@paperclipai/db";
import { budgetService } from "../services/budgets.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

type SelectResult = unknown[];

function createDbStub(selectResults: SelectResult[]) {
  const pendingSelects = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectThen = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(pendingSelects.shift() ?? [])));
  const selectOrderBy = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectFrom = vi.fn(() => ({
    where: selectWhere,
    then: selectThen,
    orderBy: selectOrderBy,
  }));
  const select = vi.fn(() => ({
    from: selectFrom,
  }));

  const insertValues = vi.fn();
  const insertReturning = vi.fn(async () => pendingInserts.shift() ?? []);
  const insert = vi.fn(() => ({
    values: insertValues.mockImplementation(() => ({
      returning: insertReturning,
    })),
  }));

  const updateSet = vi.fn();
  const updateWhere = vi.fn(async () => pendingUpdates.shift() ?? []);
  const update = vi.fn(() => ({
    set: updateSet.mockImplementation(() => ({
      where: updateWhere,
    })),
  }));

  const pendingInserts: unknown[][] = [];
  const pendingUpdates: unknown[][] = [];

  return {
    db: {
      select,
      insert,
      update,
    },
    queueInsert: (rows: unknown[]) => {
      pendingInserts.push(rows);
    },
    queueUpdate: (rows: unknown[] = []) => {
      pendingUpdates.push(rows);
    },
    selectWhere,
    insertValues,
    updateSet,
  };
}

describe("budgetService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a hard-stop incident and pauses an agent when spend exceeds a budget", async () => {
    const policy = {
      id: "policy-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    const dbStub = createDbStub([
      [policy],
      [{ total: 150 }],
      [],
      [{
        companyId: "company-1",
        name: "Budget Agent",
        status: "running",
        pauseReason: null,
      }],
    ]);

    dbStub.queueInsert([{
      id: "approval-1",
      companyId: "company-1",
      status: "pending",
    }]);
    dbStub.queueInsert([{
      id: "incident-1",
      companyId: "company-1",
      policyId: "policy-1",
      approvalId: "approval-1",
    }]);
    dbStub.queueUpdate([]);
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);

    const service = budgetService(dbStub.db as any, { cancelWorkForScope });
    await service.evaluateCostEvent({
      companyId: "company-1",
      agentId: "agent-1",
      projectId: null,
    } as any);

    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        type: "budget_override_required",
        status: "pending",
      }),
    );
    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        policyId: "policy-1",
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 150,
        approvalId: "approval-1",
      }),
    );
    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "paused",
        pauseReason: "budget",
        pausedAt: expect.any(Date),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "budget.hard_threshold_crossed",
        entityId: "incident-1",
      }),
    );
    expect(cancelWorkForScope).toHaveBeenCalledWith({
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
    });
  });

  it("blocks new work when an agent hard-stop remains exceeded even if the agent is not paused yet", async () => {
    const agentPolicy = {
      id: "policy-agent-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    };

    const dbStub = createDbStub([
      [{
        status: "running",
        pauseReason: null,
        companyId: "company-1",
        name: "Budget Agent",
      }],
      [{
        status: "active",
        name: "Paperclip",
      }],
      [],
      [agentPolicy],
      [{ total: 120 }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    expect(block).toEqual({
      scopeType: "agent",
      scopeId: "agent-1",
      scopeName: "Budget Agent",
      reason: "Agent cannot start because its budget hard-stop is still exceeded.",
    });
  });

  it("surfaces a budget-owned company pause distinctly from a manual pause", async () => {
    const dbStub = createDbStub([
      [{
        status: "idle",
        pauseReason: null,
        companyId: "company-1",
        name: "Budget Agent",
      }],
      [{
        status: "paused",
        pauseReason: "budget",
        name: "Paperclip",
      }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    expect(block).toEqual({
      scopeType: "company",
      scopeId: "company-1",
      scopeName: "Paperclip",
      reason: "Company is paused because its budget hard-stop was reached.",
    });
  });

  it("uses live observed spend when raising a budget incident", async () => {
    const dbStub = createDbStub([
      [{
        id: "incident-1",
        companyId: "company-1",
        policyId: "policy-1",
        amountObserved: 120,
        approvalId: "approval-1",
      }],
      [{
        id: "policy-1",
        companyId: "company-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
      }],
      [{ total: 150 }],
    ]);

    const service = budgetService(dbStub.db as any);

    await expect(
      service.resolveIncident(
        "company-1",
        "incident-1",
        { action: "raise_budget_and_resume", amount: 140 },
        "board-user",
      ),
    ).rejects.toThrow("New budget must exceed current observed spend");
  });

  it("syncs company monthly budget when raising and resuming a company incident", async () => {
    const now = new Date();
    const dbStub = createDbStub([
      [{
        id: "incident-1",
        companyId: "company-1",
        policyId: "policy-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        windowStart: now,
        windowEnd: now,
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 120,
        status: "open",
        approvalId: "approval-1",
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      }],
      [{
        id: "policy-1",
        companyId: "company-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
      }],
      [{ total: 120 }],
      [{ id: "approval-1", status: "approved" }],
      [{
        companyId: "company-1",
        name: "Paperclip",
        status: "paused",
        pauseReason: "budget",
        pausedAt: now,
      }],
    ]);

    const service = budgetService(dbStub.db as any);
    await service.resolveIncident(
      "company-1",
      "incident-1",
      { action: "raise_budget_and_resume", amount: 175 },
      "board-user",
    );

    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetMonthlyCents: 175,
        updatedAt: expect.any(Date),
      }),
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("budgetService release gate enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budgets-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    mockLogActivity.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createBudgetFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Budget Project",
      status: "in_progress",
    });

    return { companyId, agentId, projectId };
  }

  async function insertCostEvent(input: {
    companyId: string;
    agentId: string;
    projectId?: string | null;
    costCents: number;
    occurredAt?: Date;
  }) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        projectId: input.projectId ?? null,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5-release-gate",
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        costCents: input.costCents,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning();

    return event!;
  }

  it("raises one soft incident per window before hard-stopping and safely logging agent telemetry", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    const [policy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    const softEvent = await insertCostEvent({ companyId, agentId, costCents: 80 });
    await service.evaluateCostEvent(softEvent);
    await service.evaluateCostEvent(softEvent);

    let incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    expect(incidentRows[0]).toMatchObject({
      companyId,
      policyId: policy!.id,
      scopeType: "agent",
      scopeId: agentId,
      thresholdType: "soft",
      amountLimit: 100,
      amountObserved: 80,
      approvalId: null,
      status: "open",
    });

    const [agentBeforeHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(agentBeforeHardStop).toEqual({ status: "active", pauseReason: null });

    const hardEvent = await insertCostEvent({ companyId, agentId, costCents: 25 });
    await service.evaluateCostEvent(hardEvent);
    await service.evaluateCostEvent(hardEvent);

    incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    expect(incidentRows.find((incident) => incident.thresholdType === "soft")).toMatchObject({
      status: "resolved",
    });
    expect(incidentRows.find((incident) => incident.thresholdType === "hard")).toMatchObject({
      amountLimit: 100,
      amountObserved: 105,
      status: "open",
    });

    const [approval] = await db.select().from(approvals);
    expect(approval).toMatchObject({
      companyId,
      type: "budget_override_required",
      status: "pending",
    });

    const [agentAfterHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason, pausedAt: agents.pausedAt })
      .from(agents);
    expect(agentAfterHardStop).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(agentAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(2);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "agent", scopeId: agentId });

    const block = await service.getInvocationBlock(companyId, agentId);
    expect(block).toEqual({
      scopeType: "agent",
      scopeId: agentId,
      scopeName: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      reason: "Agent is paused because its budget hard-stop was reached.",
    });

    const telemetryCalls = mockLogActivity.mock.calls.map(([, input]) => input);
    expect(telemetryCalls.filter((call) => call.action === "budget.soft_threshold_crossed")).toHaveLength(1);
    expect(telemetryCalls.filter((call) => call.action === "budget.hard_threshold_crossed")).toHaveLength(1);
    expect(telemetryCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "budget.soft_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 80,
            amountLimit: 100,
          }),
        }),
        expect.objectContaining({
          action: "budget.hard_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 105,
            amountLimit: 100,
            approvalId: approval!.id,
          }),
        }),
      ]),
    );
    for (const call of telemetryCalls) {
      expect(JSON.stringify(call.details)).not.toContain("SECRET_TOKEN_SHOULD_NOT_LEAK");
      expect(call.details).not.toHaveProperty("prompt");
      expect(call.details).not.toHaveProperty("message");
    }
  });

  it("hard-stops project work until a valid budget raise resumes it and overview reconciles ledger spend", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 100,
      warnPercent: 75,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const event = await insertCostEvent({ companyId, agentId, projectId, costCents: 125 });
    await service.evaluateCostEvent(event);
    await service.evaluateCostEvent(event);

    const incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    const hardIncident = incidentRows.find((incident) => incident.thresholdType === "hard")!;
    expect(hardIncident).toMatchObject({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      amountLimit: 100,
      amountObserved: 125,
      status: "open",
    });

    const [projectAfterHardStop] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterHardStop?.pauseReason).toBe("budget");
    expect(projectAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "project", scopeId: projectId });

    const overviewWhileBlocked = await service.overview(companyId);
    expect(overviewWhileBlocked.pausedProjectCount).toBe(1);
    expect(overviewWhileBlocked.pendingApprovalCount).toBe(1);
    expect(overviewWhileBlocked.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 100,
      observedAmount: 125,
      remainingAmount: 0,
      utilizationPercent: 125,
      status: "hard_stop",
      paused: true,
      pauseReason: "budget",
    });
    expect(overviewWhileBlocked.activeIncidents).toHaveLength(1);

    await expect(
      service.resolveIncident(
        companyId,
        hardIncident.id,
        { action: "raise_budget_and_resume", amount: 125 },
        "board-user",
      ),
    ).rejects.toThrow("New budget must exceed current observed spend");

    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toEqual({
      scopeType: "project",
      scopeId: projectId,
      scopeName: "Budget Project",
      reason: "Project cannot start work because its budget hard-stop is still exceeded.",
    });

    const resolved = await service.resolveIncident(
      companyId,
      hardIncident.id,
      { action: "raise_budget_and_resume", amount: 175, decisionNote: "Approved release-gate budget raise." },
      "board-user",
    );
    expect(resolved).toMatchObject({ status: "resolved", approvalStatus: "approved" });

    const [projectAfterResume] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterResume).toEqual({ pauseReason: null, pausedAt: null });
    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toBeNull();

    const overviewAfterResume = await service.overview(companyId);
    expect(overviewAfterResume.pausedProjectCount).toBe(0);
    expect(overviewAfterResume.pendingApprovalCount).toBe(0);
    expect(overviewAfterResume.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 175,
      observedAmount: 125,
      remainingAmount: 50,
      utilizationPercent: expect.closeTo(71.43, 2),
      status: "ok",
      paused: false,
      pauseReason: null,
    });
    expect(overviewAfterResume.activeIncidents).toHaveLength(0);
  });
  async function insertTokenEvent(input: {
    companyId: string;
    agentId: string;
    occurredAt: Date;
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  }) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "subscription_included",
        model: "claude-sonnet-4-5",
        inputTokens: input.inputTokens,
        cachedInputTokens: input.cachedInputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        costCents: 0,
        occurredAt: input.occurredAt,
      })
      .returning();
    return event!;
  }

  it("hard-stops an agent on a daily token policy with bigint-safe amounts and resumes after the UTC day rolls over", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const lateYesterday = new Date("2026-09-27T23:30:00Z");
    const service = budgetService(db, { cancelWorkForScope, now: () => lateYesterday });

    // 5 billion tokens per UTC day: far beyond a 32-bit integer.
    const [policy] = await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "tokens",
      windowKind: "calendar_day_utc",
      amount: 5_000_000_000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    }).returning();
    expect(typeof policy!.amount).toBe("number");
    expect(policy!.amount).toBe(5_000_000_000);

    // Three events on the 27th: 2B input + 100M cached + 50M output each = 6.45B tokens, cost 0.
    const occurredAt = new Date("2026-09-27T20:00:00Z");
    let event = await insertTokenEvent({ companyId, agentId, occurredAt, inputTokens: 2_000_000_000, cachedInputTokens: 100_000_000, outputTokens: 50_000_000 });
    await service.evaluateCostEvent(event);
    event = await insertTokenEvent({ companyId, agentId, occurredAt, inputTokens: 2_000_000_000, cachedInputTokens: 100_000_000, outputTokens: 50_000_000 });
    await service.evaluateCostEvent(event);
    // Two events = 4.3B: over the 80% soft threshold (4B), under the hard stop.
    let [agentRow] = await db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents);
    expect(agentRow).toEqual({ status: "active", pauseReason: null });
    let incidents = await db.select().from(budgetIncidents);
    expect(incidents.map((incident) => incident.thresholdType)).toEqual(["soft"]);
    expect(incidents[0]).toMatchObject({ metric: "tokens", windowKind: "calendar_day_utc", amountLimit: 5_000_000_000, amountObserved: 4_300_000_000 });

    event = await insertTokenEvent({ companyId, agentId, occurredAt, inputTokens: 2_000_000_000, cachedInputTokens: 100_000_000, outputTokens: 50_000_000 });
    await service.evaluateCostEvent(event);

    [agentRow] = await db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents);
    expect(agentRow).toEqual({ status: "paused", pauseReason: "budget" });
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "agent", scopeId: agentId });
    incidents = await db.select().from(budgetIncidents);
    const hardIncident = incidents.find((incident) => incident.thresholdType === "hard")!;
    expect(hardIncident).toMatchObject({
      metric: "tokens",
      windowKind: "calendar_day_utc",
      windowStart: new Date("2026-09-27T00:00:00Z"),
      windowEnd: new Date("2026-09-28T00:00:00Z"),
      amountLimit: 5_000_000_000,
      amountObserved: 6_450_000_000,
      status: "open",
    });
    expect(typeof hardIncident.amountObserved).toBe("number");
    expect(incidents.find((incident) => incident.thresholdType === "soft")!.status).toBe("resolved");

    const overview = await service.overview(companyId);
    expect(overview.policies[0]).toMatchObject({
      metric: "tokens",
      windowKind: "calendar_day_utc",
      amount: 5_000_000_000,
      observedAmount: 6_450_000_000,
      remainingAmount: 0,
      utilizationPercent: 129,
      status: "hard_stop",
      paused: true,
      pauseReason: "budget",
      windowStart: new Date("2026-09-27T00:00:00Z"),
      windowEnd: new Date("2026-09-28T00:00:00Z"),
    });
    expect(overview.pausedAgentCount).toBe(1);
    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({ scopeType: "agent", scopeId: agentId });

    // Still the same UTC day: the sweep must leave the pause in place.
    expect((await service.reconcileWindowRollovers()).resumed).toEqual([]);
    [agentRow] = await db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents);
    expect(agentRow).toEqual({ status: "paused", pauseReason: "budget" });

    // A new UTC day: usage in the current window is 0, so the agent resumes and the incident resolves.
    const nextDay = budgetService(db, { cancelWorkForScope, now: () => new Date("2026-09-28T00:05:00Z") });
    expect((await nextDay.reconcileWindowRollovers()).resumed).toEqual([{ companyId, scopeType: "agent", scopeId: agentId }]);
    [agentRow] = await db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents);
    expect(agentRow).toEqual({ status: "idle", pauseReason: null });
    incidents = await db.select().from(budgetIncidents);
    expect(incidents.every((incident) => incident.status === "resolved")).toBe(true);
    expect(await nextDay.getInvocationBlock(companyId, agentId)).toBeNull();
    const overviewAfter = await nextDay.overview(companyId);
    expect(overviewAfter.policies[0]).toMatchObject({
      observedAmount: 0,
      remainingAmount: 5_000_000_000,
      status: "ok",
      paused: false,
      windowStart: new Date("2026-09-28T00:00:00Z"),
    });
    expect(overviewAfter.activeIncidents).toEqual([]);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "budget.window_rolled_over", entityId: agentId }),
    );
    // Idempotent: nothing left to resume.
    expect((await nextDay.reconcileWindowRollovers()).resumed).toEqual([]);
  });

  it("keeps dollar and token policies on the same agent independent and blocks invocation on either hard stop", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const now = new Date("2026-09-28T12:00:00Z");
    const service = budgetService(db, { now: () => now });

    await service.upsertPolicy(companyId, { scopeType: "agent", scopeId: agentId, metric: "billed_cents", windowKind: "calendar_month_utc", amount: 10_000 }, "board-user");
    const tokenPolicy = await service.upsertPolicy(companyId, { scopeType: "agent", scopeId: agentId, metric: "tokens", windowKind: "calendar_day_utc", amount: 1_000 }, "board-user");
    expect(tokenPolicy).toMatchObject({ metric: "tokens", windowKind: "calendar_day_utc", amount: 1_000, observedAmount: 0, status: "ok" });

    // The monthly dollar mirror on the agent row is untouched by the token policy.
    const [agentBudget] = await db.select({ budgetMonthlyCents: agents.budgetMonthlyCents }).from(agents);
    expect(agentBudget?.budgetMonthlyCents).toBe(10_000);

    // Yesterday's tokens do not count toward today's daily window.
    await insertTokenEvent({ companyId, agentId, occurredAt: new Date("2026-09-27T12:00:00Z"), inputTokens: 5_000 });
    const event = await insertTokenEvent({ companyId, agentId, occurredAt: new Date("2026-09-28T11:00:00Z"), inputTokens: 900, outputTokens: 100 });
    await service.evaluateCostEvent(event);

    const overview = await service.overview(companyId);
    const tokens = overview.policies.find((policy) => policy.metric === "tokens")!;
    const dollars = overview.policies.find((policy) => policy.metric === "billed_cents")!;
    expect(tokens).toMatchObject({ observedAmount: 1_000, status: "hard_stop", paused: true });
    expect(dollars).toMatchObject({ observedAmount: 0, status: "ok" });
    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({
      scopeType: "agent",
      reason: "Agent is paused because its budget hard-stop was reached.",
    });

    // Raising the token limit above observed usage resumes the agent immediately.
    const raised = await service.upsertPolicy(companyId, { scopeType: "agent", scopeId: agentId, metric: "tokens", windowKind: "calendar_day_utc", amount: 20_000_000 }, "board-user");
    expect(raised).toMatchObject({ amount: 20_000_000, observedAmount: 1_000, status: "ok", paused: false });
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();
  });
});
