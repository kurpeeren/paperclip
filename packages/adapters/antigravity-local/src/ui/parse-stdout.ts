import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readStepIndex(step: Record<string, unknown>): number | null {
  const raw = step.step_index;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

function toolUseIdFor(stepIndex: number | null): string {
  return stepIndex === null ? "tool" : `step-${stepIndex}`;
}

/**
 * Map one `agy --output-format stream-json` stdout line to transcript entries.
 * Verified shapes (agy 1.2.12): init (conversation_id + model), step_update
 * (agent_response text deltas, tool ACTIVE/DONE with tool_info parameters +
 * output, user_input / system_message markers) and a trailing result event
 * with status, response, and conversation-cumulative usage.
 */
export function parseAntigravityStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const kind = asString(parsed.event).trim().toLowerCase();

  if (kind === "init") {
    const init = asRecord(parsed.init);
    const sessionId = asString(parsed.conversation_id).trim() || asString(init?.conversation_id).trim();
    const model = asString(init?.model).trim();
    if (!sessionId && !model) return [];
    return [{ kind: "init", ts, model, sessionId }];
  }

  if (kind === "step_update") {
    const step = asRecord(parsed.step_update);
    if (!step) return [];
    const stepType = asString(step.step_type).trim().toLowerCase();
    const stepIndex = readStepIndex(step);

    if (stepType === "agent_response") {
      const delta = asString(step.text_delta);
      if (!delta.trim()) return [];
      return [{
        kind: "assistant",
        ts,
        text: delta,
        delta: true,
        channel: "final",
        ...(stepIndex !== null ? { itemId: `step-${stepIndex}` } : {}),
      }];
    }

    if (stepType === "tool") {
      const info = asRecord(step.tool_info);
      const name = asString(step.tool_name, asString(info?.name, "tool")).trim() || "tool";
      const state = asString(step.state).trim().toUpperCase();
      const toolUseId = toolUseIdFor(stepIndex);
      const hasOutput = Boolean(info) && (
        Object.prototype.hasOwnProperty.call(info, "output") ||
        Object.prototype.hasOwnProperty.call(info, "error")
      );
      if (state === "DONE" && hasOutput) {
        const isError = Object.prototype.hasOwnProperty.call(info, "error") && info!.error !== null && info!.error !== undefined;
        const raw = isError ? info!.error : info!.output;
        return [{
          kind: "tool_result",
          ts,
          toolUseId,
          toolName: name,
          content: stringifyUnknown(raw),
          isError,
        }];
      }
      if (state === "DONE") {
        // A DONE without output is a tool that produced nothing; still show
        // the call so the transcript explains the step.
        return [{ kind: "tool_call", ts, name, input: info?.parameters ?? {}, toolUseId }];
      }
      return [{ kind: "tool_call", ts, name, input: info?.parameters ?? {}, toolUseId }];
    }

    // user_input / system_message and unknown step types carry nothing to render.
    return [];
  }

  if (kind === "result") {
    const result = asRecord(parsed.result) ?? parsed;
    const status = asString(result.status).trim().toUpperCase();
    const usage = asRecord(result.usage);
    const isError = Boolean(status) && status !== "SUCCESS";
    const errorText = stringifyUnknown(result.error).trim();
    const response = asString(result.response);
    const outputTokens = asNumber(usage?.output_tokens);
    const thinkingTokens = asNumber(usage?.thinking_tokens);
    return [{
      kind: "result",
      ts,
      text: response,
      inputTokens: asNumber(usage?.input_tokens),
      // total_tokens == input + output on agy, so thinking is already inside output.
      outputTokens: Math.max(outputTokens, thinkingTokens),
      cachedTokens: asNumber(usage?.cache_read_tokens),
      // Antigravity is subscription-billed; agy reports no USD cost.
      costUsd: 0,
      subtype: status ? status.toLowerCase() : "result",
      isError,
      errors: isError ? [errorText || response.trim() || `status ${status}`] : [],
    }];
  }

  if (kind === "error") {
    const text =
      stringifyUnknown(parsed.error).trim() ||
      asString(parsed.message) ||
      asString(parsed.detail) ||
      "Antigravity error";
    return [{ kind: "stderr", ts, text }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
