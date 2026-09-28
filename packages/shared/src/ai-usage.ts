import { z } from "zod";

/**
 * Model families used by the dashboard "Model usage" panel. Derived from the
 * model id recorded on a cost event, with the provider as a fallback signal.
 */
export const AI_USAGE_MODEL_FAMILIES = ["claude", "gemini", "openai", "local", "other"] as const;
export type AiUsageModelFamily = (typeof AI_USAGE_MODEL_FAMILIES)[number];

export const AI_USAGE_MODEL_FAMILY_LABELS: Record<AiUsageModelFamily, string> = {
  claude: "Claude",
  gemini: "Gemini",
  openai: "OpenAI",
  local: "Local (Ollama)",
  other: "Other",
};

export const AI_USAGE_PERIODS = ["today", "7d", "30d"] as const;
export type AiUsagePeriod = (typeof AI_USAGE_PERIODS)[number];
export const aiUsagePeriodSchema = z.enum(AI_USAGE_PERIODS);

export const AI_USAGE_PERIOD_LABELS: Record<AiUsagePeriod, string> = {
  today: "Today",
  "7d": "7 days",
  "30d": "30 days",
};

/** Keys of the Anthropic OAuth usage windows the dashboard understands. */
export const AI_SUBSCRIPTION_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour window",
  seven_day: "7-day window (all models)",
  seven_day_opus: "7-day window (Opus)",
  seven_day_sonnet: "7-day window (Sonnet)",
};

const LOCAL_MODEL_PATTERN = /(^|[/:])(ollama|llama|mistral|mixtral|qwen|phi-|phi[0-9]|gemma|deepseek|codellama|vicuna|lmstudio)/;

/**
 * Map a model id (and, as a fallback, the recording provider) to a family.
 * Model ids arrive in many shapes: `claude-sonnet-4-5`, `openrouter/anthropic/claude-3`,
 * `gpt-5-codex`, `o3`, `gemini-2.5-pro`, `ollama/llama3`, `unknown`.
 */
export function modelFamilyForModel(model: string | null | undefined, provider?: string | null): AiUsageModelFamily {
  const id = (model ?? "").trim().toLowerCase();
  const providerId = (provider ?? "").trim().toLowerCase();

  if (id.includes("claude")) return "claude";
  if (id.includes("gemini")) return "gemini";
  if (/(^|[/:])(gpt-|o[1-9](-|$)|codex|chatgpt|text-embedding|davinci)/.test(id)) return "openai";
  if (id.startsWith("ollama") || providerId === "ollama" || providerId === "local") return "local";
  if (LOCAL_MODEL_PATTERN.test(id)) return "local";

  switch (providerId) {
    case "anthropic":
      return "claude";
    case "google":
    case "gemini":
      return "gemini";
    case "openai":
      return "openai";
    default:
      return "other";
  }
}
