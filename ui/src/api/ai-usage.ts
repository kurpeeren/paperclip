import type { AiSubscriptionUsage, AiUsageSummary } from "@paperclipai/shared";
import { api } from "./client";

export const aiUsageApi = {
  subscription: (companyId: string) =>
    api.get<AiSubscriptionUsage>(`/companies/${companyId}/ai-usage/subscription`),
  antigravity: (companyId: string) =>
    api.get<AiSubscriptionUsage>(`/companies/${companyId}/ai-usage/antigravity`),
  summary: (companyId: string) =>
    api.get<AiUsageSummary>(`/companies/${companyId}/ai-usage/summary`),
};
