import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockUsageService = vi.hoisted(() => ({
  subscriptionUsage: vi.fn(),
  summary: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
}));

vi.mock("../services/ai-usage.js", () => ({
  aiUsageService: () => mockUsageService,
}));

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

async function createApp(actor: Record<string, unknown> = boardActor) {
  vi.resetModules();
  const [{ errorHandler }, { aiUsageRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/ai-usage.js") as Promise<typeof import("../routes/ai-usage.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", aiUsageRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("ai-usage routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyService.getById.mockImplementation(async (id: string) =>
      id === "company-1" || id === "company-2" ? { id, name: "Co" } : null,
    );
    mockUsageService.subscriptionUsage.mockResolvedValue({
      available: true,
      provider: "anthropic",
      windows: [{ key: "five_hour", label: "5-hour window", utilization: 42, resetsAt: null }],
      fetchedAt: "2026-09-28T12:00:00.000Z",
    });
    mockUsageService.summary.mockResolvedValue({
      companyId: "company-1",
      generatedAt: "2026-09-28T12:00:00.000Z",
      periods: [],
    });
  });

  it("returns subscription usage for a board member of the company", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/ai-usage/subscription");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.windows[0].utilization).toBe(42);
    expect(mockUsageService.subscriptionUsage).toHaveBeenCalledWith("company-1", "user-1");
  });

  it("passes through available:false without turning it into an error", async () => {
    mockUsageService.subscriptionUsage.mockResolvedValue({
      available: false,
      provider: "anthropic",
      reason: "No Claude subscription is connected for this organization.",
    });
    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/ai-usage/subscription");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: false,
      provider: "anthropic",
      reason: "No Claude subscription is connected for this organization.",
    });
  });

  it("returns the model-family summary", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/ai-usage/summary");
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe("company-1");
    expect(mockUsageService.summary).toHaveBeenCalledWith("company-1");
  });

  it("rejects board users who are not members of the company", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/companies/company-2/ai-usage/subscription");
    expect(res.status).toBe(403);
    expect(mockUsageService.subscriptionUsage).not.toHaveBeenCalled();
  });

  it("rejects agent actors even for their own company", async () => {
    const app = await createApp({
      type: "agent",
      companyId: "company-1",
      agentId: "agent-1",
      source: "agent_key",
    });
    const res = await request(app).get("/api/companies/company-1/ai-usage/summary");
    expect(res.status).toBe(403);
    expect(mockUsageService.summary).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown company or the __none__ sentinel", async () => {
    const app = await createApp({ ...boardActor, companyIds: ["company-1", "missing", "__none__"] });
    const missing = await request(app).get("/api/companies/missing/ai-usage/subscription");
    expect(missing.status).toBe(404);
    const sentinel = await request(app).get("/api/companies/__none__/ai-usage/summary");
    expect(sentinel.status).toBe(404);
    expect(mockUsageService.subscriptionUsage).not.toHaveBeenCalled();
    expect(mockUsageService.summary).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const app = await createApp({ type: "none" });
    const res = await request(app).get("/api/companies/company-1/ai-usage/subscription");
    expect(res.status).toBe(401);
  });
});
