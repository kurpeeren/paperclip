import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companyService } from "../services/index.js";
import { aiUsageService, type AiUsageServiceDeps } from "../services/ai-usage.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Board-only, company-scoped model usage for the dashboard:
 * - `subscription`: live Claude subscription quota windows via the operator's
 *   stored Anthropic subscription connection (token never leaves the server)
 * - `summary`: token/cost totals per model family from Paperclip's own cost events
 */
export function aiUsageRoutes(db: Db, options: { deps?: AiUsageServiceDeps } = {}) {
  const router = Router();
  const companies = companyService(db);
  const usage = aiUsageService(db, options.deps);

  async function resolveCompany(req: Parameters<typeof assertCompanyAccess>[0], res: any, companyId: string) {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    // Reject the "__none__" sentinel and forged ids before touching credentials.
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return null;
    }
    return company;
  }

  router.get("/companies/:companyId/ai-usage/subscription", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await resolveCompany(req, res, companyId))) return;
    const actor = getActorInfo(req);
    const result = await usage.subscriptionUsage(companyId, actor.actorId);
    res.json(result);
  });

  router.get("/companies/:companyId/ai-usage/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!(await resolveCompany(req, res, companyId))) return;
    const result = await usage.summary(companyId);
    res.json(result);
  });

  return router;
}
