import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAntigravityStdoutLine } from "./parse-stdout.js";

const ts = "2026-09-28T00:00:00.000Z";
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "fixtures");
const toolCallLines = fs.readFileSync(path.join(fixturesDir, "stream-json-tool-call.ndjson"), "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0);

describe("parseAntigravityStdoutLine", () => {
  it("renders the init event as an init entry with model and conversation id", () => {
    expect(parseAntigravityStdoutLine(toolCallLines[0], ts)).toEqual([
      { kind: "init", ts, model: "gemini-3.8-flash-medium", sessionId: "023827b5-e2cb-4967-b61c-2488666ca7af" },
    ]);
  });

  it("ignores user_input steps and agent_response steps without text", () => {
    expect(parseAntigravityStdoutLine(toolCallLines[1], ts)).toEqual([]);
    expect(parseAntigravityStdoutLine(toolCallLines[2], ts)).toEqual([]);
  });

  it("renders an ACTIVE tool step as a tool_call keyed by step index", () => {
    expect(parseAntigravityStdoutLine(toolCallLines[3], ts)).toEqual([
      { kind: "tool_call", ts, name: "run_command", input: { CommandLine: "ls /tmp | head -3" }, toolUseId: "step-2" },
    ]);
  });

  it("renders a DONE tool step with output as a tool_result", () => {
    expect(parseAntigravityStdoutLine(toolCallLines[4], ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "step-2",
        toolName: "run_command",
        content: "Centauri\r\nFTABHarvest\r\nRustDesk-501\r\n",
        isError: false,
      },
    ]);
  });

  it("renders agent_response text deltas as streaming assistant entries", () => {
    expect(parseAntigravityStdoutLine(toolCallLines[5], ts)).toEqual([
      {
        kind: "assistant",
        ts,
        text: "The command printed **3** lines:\n\n```text\nCentauri\nFTABHarvest\nRustDesk-501\n```\n",
        delta: true,
        channel: "final",
        itemId: "step-3",
      },
    ]);
  });

  it("renders the result event with usage and no cost", () => {
    expect(parseAntigravityStdoutLine(toolCallLines[6], ts)).toEqual([
      {
        kind: "result",
        ts,
        text: "The command printed **3** lines:\n\n```text\nCentauri\nFTABHarvest\nRustDesk-501\n```\n",
        inputTokens: 24794,
        outputTokens: 189,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("renders a non-SUCCESS result as an error result entry", () => {
    const line = JSON.stringify({
      event: "result",
      result: { conversation_id: "", status: "ERROR", response: "", error: "invalid model selection", usage: { input_tokens: 0, output_tokens: 0 } },
    });
    const [entry] = parseAntigravityStdoutLine(line, ts);
    expect(entry).toMatchObject({ kind: "result", subtype: "error", isError: true, errors: ["invalid model selection"] });
  });

  it("marks a tool step carrying an error as a failed tool_result", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: { step_index: 7, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: {}, error: "no such file" } },
    });
    expect(parseAntigravityStdoutLine(line, ts)).toEqual([
      { kind: "tool_result", ts, toolUseId: "step-7", toolName: "view_file", content: "no such file", isError: true },
    ]);
  });

  it("passes non-JSON lines through as stdout", () => {
    expect(parseAntigravityStdoutLine("plain output line", ts)).toEqual([
      { kind: "stdout", ts, text: "plain output line" },
    ]);
  });
});
