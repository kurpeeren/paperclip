import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

export interface ParsedAntigravityToolCall {
  id: string | null;
  name: string;
  arguments: unknown;
}

export interface ParsedAntigravityToolResult {
  toolCallId: string | null;
  content: string;
}

export interface ParsedAntigravityStream {
  /** `conversation_id` from the init event (falls back to any step/result id). */
  sessionId: string | null;
  /** Model reported by the init event (absent on resumed conversations). */
  model: string | null;
  /** Final board-facing text: `result.response`, else the last agent_response step. */
  summary: string;
  toolCalls: ParsedAntigravityToolCall[];
  toolResults: ParsedAntigravityToolResult[];
  /** Token usage for this invocation, or null when agy reported none. */
  usage: UsageSummary | null;
  /**
   * "per_run" when usage was summed from this run's step_update events;
   * "session_cumulative" when only `result.usage` was available (agy reports
   * conversation-wide totals there, verified on a resumed conversation).
   */
  usageBasis: "per_run" | "session_cumulative" | null;
  /** `result.status` (SUCCESS / ERROR / ...), null when no result event arrived. */
  status: string | null;
  numTurns: number | null;
  errorMessage: string | null;
}

/**
 * Synthetic tool-call id: agy does not assign ids to tool steps, so the step
 * index (unique within a conversation) links a tool call to its result.
 */
export function antigravityToolCallId(stepIndex: number | null): string | null {
  return stepIndex === null ? null : `step-${stepIndex}`;
}

function readStepIndex(step: Record<string, unknown>): number | null {
  const raw = step.step_index;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

function readUsage(raw: unknown): UsageSummary | null {
  const usage = parseObject(raw);
  if (Object.keys(usage).length === 0) return null;
  const inputTokens = asNumber(usage.input_tokens, 0);
  const outputTokens = asNumber(usage.output_tokens, 0);
  // agy's total_tokens == input_tokens + output_tokens, so thinking_tokens is
  // already folded into output_tokens. Guard anyway so a future split never
  // drops reasoning tokens from the output count.
  const thinkingTokens = asNumber(usage.thinking_tokens, 0);
  const cachedInputTokens = asNumber(usage.cache_read_tokens, 0);
  return {
    inputTokens,
    outputTokens: Math.max(outputTokens, thinkingTokens),
    cachedInputTokens,
  };
}

function addUsage(target: UsageSummary, delta: UsageSummary): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cachedInputTokens = (target.cachedInputTokens ?? 0) + (delta.cachedInputTokens ?? 0);
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message =
    asString(rec.message, "").trim() ||
    asString(rec.error, "").trim() ||
    asString(rec.detail, "").trim() ||
    asString(rec.code, "").trim();
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

/**
 * Build the run summary that Paperclip may auto-post as an issue comment:
 * the final response when agy reported one, else the last non-empty
 * agent_response step (intermediate "let me check..." steps are skipped).
 */
export function buildAntigravityRunSummary(finalResponse: string | null, agentResponses: string[]): string {
  const response = (finalResponse ?? "").trim();
  if (response) return response;
  for (let i = agentResponses.length - 1; i >= 0; i -= 1) {
    const text = (agentResponses[i] ?? "").trim();
    if (text) return text;
  }
  return "";
}

/**
 * Parse `agy --output-format stream-json ... -p <prompt>` stdout (NDJSON).
 *
 * Verified event shapes (agy 1.2.12), see ./fixtures:
 * - {"event":"init","conversation_id":"...","init":{"model":"...","cwd":"...","tools":[...],"permission_mode":"..."}}
 * - {"event":"step_update","step_update":{"conversation_id":"...","step_index":N,"state":"ACTIVE|DONE","step_type":"user_input|system_message|agent_response|tool",
 *      "text_delta":"...", "tool_name":"...", "tool_info":{"name":"...","parameters":{...},"output":"..."}, "duration_seconds":N, "usage":{...}}}
 * - {"event":"result","result":{"conversation_id":"...","status":"SUCCESS|ERROR","response":"...","error":"...","duration_seconds":N,"num_turns":N,"usage":{...}}}
 *
 * Tool steps arrive twice (ACTIVE with parameters, DONE with parameters +
 * output); both carry the same step_index. agent_response steps stream
 * text_delta fragments across ACTIVE/DONE updates for one step_index.
 */
export function parseAntigravityStreamJson(stdout: string): ParsedAntigravityStream {
  let sessionId: string | null = null;
  let model: string | null = null;
  let status: string | null = null;
  let numTurns: number | null = null;
  let errorMessage: string | null = null;
  let finalResponse: string | null = null;
  let resultUsage: UsageSummary | null = null;
  const stepUsage: UsageSummary = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let sawStepUsage = false;
  const agentResponses = new Map<number, string>();
  const anonymousResponses: string[] = [];
  const toolCallsByStep = new Map<number, ParsedAntigravityToolCall>();
  const toolCalls: ParsedAntigravityToolCall[] = [];
  const toolResults: ParsedAntigravityToolResult[] = [];
  const toolResultSteps = new Set<number>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const kind = asString(event.event, "").trim().toLowerCase();

    if (kind === "init") {
      const init = parseObject(event.init);
      sessionId = asString(event.conversation_id, "").trim() || asString(init.conversation_id, "").trim() || sessionId;
      model = asString(init.model, "").trim() || model;
      continue;
    }

    if (kind === "step_update") {
      const step = parseObject(event.step_update);
      if (!sessionId) sessionId = asString(step.conversation_id, "").trim() || null;
      const stepType = asString(step.step_type, "").trim().toLowerCase();
      const stepIndex = readStepIndex(step);
      const usage = readUsage(step.usage);
      if (usage) {
        addUsage(stepUsage, usage);
        sawStepUsage = true;
      }

      if (stepType === "agent_response") {
        const delta = asString(step.text_delta, "");
        if (delta) {
          if (stepIndex === null) anonymousResponses.push(delta);
          else agentResponses.set(stepIndex, (agentResponses.get(stepIndex) ?? "") + delta);
        }
        continue;
      }

      if (stepType === "tool") {
        const info = parseObject(step.tool_info);
        const name = asString(step.tool_name, asString(info.name, "")).trim();
        const state = asString(step.state, "").trim().toUpperCase();
        const id = antigravityToolCallId(stepIndex);
        if (name && (stepIndex === null || !toolCallsByStep.has(stepIndex))) {
          const call: ParsedAntigravityToolCall = {
            id,
            name,
            arguments: info.parameters ?? {},
          };
          if (stepIndex !== null) toolCallsByStep.set(stepIndex, call);
          toolCalls.push(call);
        }
        const hasOutput = Object.prototype.hasOwnProperty.call(info, "output") || Object.prototype.hasOwnProperty.call(info, "error");
        if ((state === "DONE" || hasOutput) && (stepIndex === null || !toolResultSteps.has(stepIndex))) {
          if (stepIndex !== null) toolResultSteps.add(stepIndex);
          const output = info.output ?? info.error ?? "";
          toolResults.push({
            toolCallId: id,
            content: typeof output === "string" ? output : errorText(output),
          });
        }
        continue;
      }

      // user_input / system_message and unknown step types carry nothing we surface.
      continue;
    }

    if (kind === "result") {
      const result = parseObject(event.result);
      sessionId = sessionId || (asString(result.conversation_id, "").trim() || null);
      status = asString(result.status, "").trim().toUpperCase() || null;
      const response = asString(result.response, "");
      if (response.trim()) finalResponse = response;
      const turns = asNumber(result.num_turns, -1);
      numTurns = turns >= 0 ? turns : null;
      resultUsage = readUsage(result.usage) ?? resultUsage;
      if (status && status !== "SUCCESS") {
        const text =
          errorText(result.error).trim() ||
          response.trim() ||
          `Antigravity run ended with status ${status}`;
        errorMessage = text;
      }
      continue;
    }

    // Defensive: tolerate a top-level error event if a future agy adds one.
    if (kind === "error") {
      const text = errorText(event.error ?? event.message ?? event.detail).trim();
      if (text) errorMessage = text;
    }
  }

  const orderedResponses = [
    ...[...agentResponses.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text),
    ...anonymousResponses,
  ];

  const usage = sawStepUsage ? stepUsage : resultUsage;
  const usageBasis: ParsedAntigravityStream["usageBasis"] = sawStepUsage
    ? "per_run"
    : resultUsage
      ? "session_cumulative"
      : null;

  return {
    sessionId,
    model,
    summary: buildAntigravityRunSummary(finalResponse, orderedResponses),
    toolCalls,
    toolResults,
    usage,
    usageBasis,
    status,
    numTurns,
    errorMessage,
  };
}

export interface ParsedAntigravityJsonOutput {
  sessionId: string | null;
  status: string | null;
  response: string;
  usage: UsageSummary | null;
  errorMessage: string | null;
}

/**
 * Parse `agy --output-format json` stdout: one JSON object with the same
 * shape as the stream-json `result` payload (used by the connection test).
 */
export function parseAntigravityJsonOutput(stdout: string): ParsedAntigravityJsonOutput {
  const trimmed = stdout.trim();
  const direct = parseJson(trimmed);
  let result: Record<string, unknown> | null = direct;
  if (!result) {
    // Tolerate leading/trailing noise: take the last line that parses.
    for (const rawLine of trimmed.split(/\r?\n/).reverse()) {
      const parsed = parseJson(rawLine.trim());
      if (parsed) {
        result = parsed;
        break;
      }
    }
  }
  if (!result) {
    return { sessionId: null, status: null, response: "", usage: null, errorMessage: null };
  }
  const payload = Object.keys(parseObject(result.result)).length > 0 ? parseObject(result.result) : result;
  const status = asString(payload.status, "").trim().toUpperCase() || null;
  const response = asString(payload.response, "");
  const errorMessage =
    status && status !== "SUCCESS"
      ? errorText(payload.error).trim() || response.trim() || `Antigravity run ended with status ${status}`
      : null;
  return {
    sessionId: asString(payload.conversation_id, "").trim() || null,
    status,
    response,
    usage: readUsage(payload.usage),
    errorMessage,
  };
}

export interface AntigravityRuntimeEvent {
  eventType: string;
  message?: string;
  payload?: Record<string, unknown>;
}

/**
 * Map a single stream-json line to live runtime events for `onEvent`, which
 * drive the issue-thread activity indicator (`currentToolName` /
 * `lastAssistantSnippet` / `lastEventAt`). Text deltas become assistant
 * snippets, ACTIVE tool steps become tool_call events. Tool results are
 * intentionally omitted so the last meaningful "Using X" / assistant snippet
 * is not overwritten by a generic label.
 */
export function extractAntigravityRuntimeEvents(line: string): AntigravityRuntimeEvent[] {
  const event = parseJson(line);
  if (!event) return [];
  if (asString(event.event, "").trim().toLowerCase() !== "step_update") return [];
  const step = parseObject(event.step_update);
  const stepType = asString(step.step_type, "").trim().toLowerCase();

  if (stepType === "agent_response") {
    const content = asString(step.text_delta, "").trim();
    return content ? [{ eventType: "assistant", message: content, payload: { content } }] : [];
  }

  if (stepType === "tool") {
    const info = parseObject(step.tool_info);
    const name = asString(step.tool_name, asString(info.name, "")).trim();
    const state = asString(step.state, "").trim().toUpperCase();
    if (!name) return [];
    const hasOutput = Object.prototype.hasOwnProperty.call(info, "output");
    // Only the first sighting of a tool step is a call; a DONE update with
    // output is its result, which the activity indicator does not need.
    if (state === "DONE" && hasOutput) return [];
    return [{ eventType: "tool_call", payload: { toolName: name } }];
  }

  return [];
}

function normalizedHaystack(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * agy 1.2.12 does not fail on an unknown `--conversation` id: it prints
 * `warning: conversation "<id>" not found` on stderr and starts a fresh
 * conversation (exit 0). Detect that so the run log explains why the stored
 * session id changed.
 */
export function detectAntigravityConversationNotFound(stderr: string): string | null {
  const match = /conversation\s+"([^"]+)"\s+not\s+found/i.exec(stderr);
  return match ? match[1] : null;
}

export function isAntigravitySessionUnrecoverableError(stdout: string, stderr: string): boolean {
  return /conversation(?:\s+"[^"]*")?\s+not\s+found|unknown\s+conversation|cannot\s+resume|failed\s+to\s+resume|invalid\s+conversation/i.test(
    normalizedHaystack(stdout, stderr),
  );
}

export function isAntigravityTransientNetworkError(stdout: string, stderr: string): boolean {
  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch\s+failed|socket\s+hang\s+up|no\s+such\s+host|connection\s+refused|i\/o\s+timeout|TLS\s+handshake\s+timeout/i.test(
    normalizedHaystack(stdout, stderr),
  );
}

export function describeAntigravityFailure(input: {
  errorMessage?: string | null;
  stderr?: string;
}): string | null {
  const detail =
    (typeof input.errorMessage === "string" ? input.errorMessage.trim() : "") ||
    (input.stderr ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ||
    "";
  if (!detail) return null;
  const clean = detail.replace(/\s+/g, " ").trim();
  const max = 240;
  return `Antigravity run failed: ${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}`;
}

const ANTIGRAVITY_AUTH_REQUIRED_RE =
  /(?:not\s+(?:logged\s+in|authenticated|signed\s+in)|\blogin\s+required\b|sign\s+in\s+(?:required|to\s+continue)|\b401\b|unauthorized|unauthenticated|authentication\s+(?:required|failed)|invalid\s+(?:credentials|oauth|token)|oauth\s+token\s+(?:expired|missing|invalid)|permission_denied)/i;

/**
 * Auth detection only inspects stderr and the structured error text: agy's
 * stdout is NDJSON that may quote arbitrary assistant prose ("sign in" in a
 * task description must not flip a run into the auth-required bucket).
 */
export function detectAntigravityAuthRequired(input: {
  stderr: string;
  errorMessage?: string | null;
}): { requiresAuth: boolean } {
  const haystack = `${input.errorMessage ?? ""}\n${input.stderr}`;
  const requiresAuth = haystack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => ANTIGRAVITY_AUTH_REQUIRED_RE.test(line));
  return { requiresAuth };
}
