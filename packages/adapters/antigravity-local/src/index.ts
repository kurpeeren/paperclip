export const type = "antigravity_local";
export const label = "Antigravity (local)";

export const DEFAULT_ANTIGRAVITY_LOCAL_MODEL = "gemini-3.8-flash-medium";

/**
 * Model ids accepted by `agy --model` (verified with `agy models`, agy 1.2.12).
 * Antigravity encodes the thinking tier in most model ids (`-low` /
 * `-medium` / `-high`); `--effort` can still override it per run.
 */
export const models = [
  { id: DEFAULT_ANTIGRAVITY_LOCAL_MODEL, label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

/**
 * Antigravity effort tiers accepted by `agy --effort`.
 */
export const ANTIGRAVITY_SUPPORTED_EFFORTS = ["low", "medium", "high", "max"] as const;
export type AntigravityEffort = (typeof ANTIGRAVITY_SUPPORTED_EFFORTS)[number];

/**
 * Map a Paperclip effort value onto Antigravity's `--effort` set. Returns
 * null for values agy cannot honor so the caller omits the flag instead of
 * forwarding an invalid tier (agy rejects the whole run on an unknown tier).
 */
export function resolveAntigravityEffort(effort: string): AntigravityEffort | null {
  const normalized = effort.trim().toLowerCase();
  if (!normalized) return null;
  return (ANTIGRAVITY_SUPPORTED_EFFORTS as readonly string[]).includes(normalized)
    ? (normalized as AntigravityEffort)
    : null;
}

export const agentConfigurationDoc = `# antigravity_local agent configuration

Adapter: antigravity_local

Use when:
- You want Paperclip to run Google's Antigravity CLI (agy) locally on the host machine, billed against the user's Antigravity subscription (Gemini models)
- You want a backup model lane next to claude_local / codex_local without extra API keys
- You want Antigravity conversations resumed across heartbeats with --conversation

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- The Antigravity CLI is not installed or signed in on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt. Sibling files in the same directory (HEARTBEAT.md, SOUL.md, TOOLS.md) are made readable via --add-dir for local runs.
- promptTemplate (string, optional): run prompt template
- model (string, optional): Antigravity model id passed via --model. Defaults to gemini-3.8-flash-medium. The thinking tier is part of the id (-low / -medium / -high).
- effort (string, optional): Antigravity effort tier (low | medium | high | max) passed via --effort. Omitted when unset so agy keeps the model's own default.
- dangerouslySkipPermissions (boolean, optional): pass --dangerously-skip-permissions so unattended runs auto-approve tool calls. Defaults to true; set false only when a human is watching the run.
- command (string, optional): defaults to "agy"
- extraArgs (string[], optional): additional CLI args inserted before the prompt
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`agy --output-format stream-json ... -p <prompt>\` for non-interactive headless execution; the prompt is passed as the LAST argument, never via stdin.
- agy has no --max-turns flag, so maxTurnsPerRun is not enforced by this adapter.
- Sessions resume with \`--conversation <id>\` when the stored session cwd matches the current cwd; the id is captured from the init event's conversation_id. An unknown id makes agy start a fresh conversation (stderr warning), and the new id replaces the stored one.
- Desired Paperclip skills are delivered to local runs via \`--add-dir\` pointing at a per-run managed skills directory, so skills load without polluting the operator's Antigravity install.
- Cost is not reported: Antigravity bills through the Google subscription, so runs record token usage with billingType "subscription" and no USD cost.
- Authentication uses the Antigravity CLI's own Google sign-in (run \`agy\` interactively once on the host).
`;
