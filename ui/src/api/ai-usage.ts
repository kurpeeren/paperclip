import type { AiSubscriptionUsage, AiUsageSummary } from "@paperclipai/shared";
import { api } from "./client";

export const aiUsageApi = {
  subscription: (companyId: string) =>
    api.get<AiSubscriptionUsage>(`/companies/${companyId}/ai-usage/subscription`),
  summary: (companyId: string) =>
    api.get<AiUsageSummary>(`/companies/${companyId}/ai-usage/summary`),
};
