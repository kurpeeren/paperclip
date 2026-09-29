import pc from "picocolors";

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

export function printAntigravityStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const kind = asString(parsed.event).trim().toLowerCase();

  if (kind === "init") {
    const init = asRecord(parsed.init);
    const sessionId = asString(parsed.conversation_id).trim() || asString(init?.conversation_id).trim();
    const model = asString(init?.model).trim();
    if (sessionId) console.log(pc.blue(`Antigravity conversation: ${sessionId}${model ? ` (${model})` : ""}`));
    return;
  }

  if (kind === "step_update") {
    const step = asRecord(parsed.step_update);
    if (!step) return;
    const stepType = asString(step.step_type).trim().toLowerCase();

    if (stepType === "agent_response") {
      const delta = asString(step.text_delta);
      if (delta.trim()) process.stdout.write(pc.green(delta.endsWith("\n") ? delta : `${delta}\n`));
      return;
    }

    if (stepType === "tool") {
      const info = asRecord(step.tool_info);
      const name = asString(step.tool_name, asString(info?.name, "tool")).trim() || "tool";
      const state = asString(step.state).trim().toUpperCase();
      const hasOutput = Boolean(info) && Object.prototype.hasOwnProperty.call(info, "output");
      if (state === "DONE" && hasOutput) {
        console.log(pc.cyan(`tool_result: ${name}`));
        const output = stringifyUnknown(info!.output);
        if (output) console.log(pc.gray(output));
        return;
      }
      console.log(pc.yellow(`tool_call: ${name}`));
      if (info?.parameters !== undefined) console.log(pc.gray(stringifyUnknown(info.parameters)));
      return;
    }

    return;
  }

  if (kind === "result") {
    const result = asRecord(parsed.result) ?? parsed;
    const status = asString(result.status).trim().toUpperCase();
    const usage = asRecord(result.usage);
    if (status && status !== "SUCCESS") {
      const error = stringifyUnknown(result.error).trim() || asString(result.response).trim() || status;
      console.log(pc.red(`error (${status}): ${error}`));
      return;
    }
    const inputTokens = asNumber(usage?.input_tokens);
    const outputTokens = asNumber(usage?.output_tokens);
    const turns = asNumber(result.num_turns, -1);
    console.log(
      pc.blue(
        `result: ${status || "done"} in=${inputTokens} out=${outputTokens}${turns >= 0 ? ` turns=${turns}` : ""}`,
      ),
    );
    return;
  }

  if (kind === "error") {
    const text =
      stringifyUnknown(parsed.error).trim() ||
      asString(parsed.message) ||
      asString(parsed.detail) ||
      "Antigravity error";
    console.log(pc.red(`error: ${text}`));
    return;
  }

  console.log(line);
}
