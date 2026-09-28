import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildAntigravityRunSummary,
  detectAntigravityAuthRequired,
  detectAntigravityConversationNotFound,
  extractAntigravityRuntimeEvents,
  isAntigravitySessionUnrecoverableError,
  isAntigravityTransientNetworkError,
  parseAntigravityJsonOutput,
  parseAntigravityStreamJson,
} from "./parse.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => fs.readFileSync(path.join(fixturesDir, name), "utf8");

const TOOL_CALL_FIXTURE = fixture("stream-json-tool-call.ndjson");
const RESUME_FIXTURE = fixture("stream-json-resume.ndjson");
const ERROR_MODEL_FIXTURE = fixture("stream-json-error-model.ndjson");
const JSON_OUTPUT_FIXTURE = fixture("json-output.json");
const CONVERSATION_NOT_FOUND_STDERR = fixture("stderr-conversation-not-found.txt");

describe("parseAntigravityStreamJson (agy 1.2.12 fixtures)", () => {
  it("parses a tool-call run: session id, tool call + result, final response, per-run usage", () => {
    const parsed = parseAntigravityStreamJson(TOOL_CALL_FIXTURE);

    expect(parsed.sessionId).toBe("023827b5-e2cb-4967-b61c-2488666ca7af");
    expect(parsed.model).toBe("gemini-3.8-flash-medium");
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.numTurns).toBe(1);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.summary).toBe("The command printed **3** lines:\n\n```text\nCentauri\nFTABHarvest\nRustDesk-501\n```");

    expect(parsed.toolCalls).toEqual([
      { id: "step-2", name: "run_command", arguments: { CommandLine: "ls /tmp | head -3" } },
    ]);
    expect(parsed.toolResults).toEqual([
      { toolCallId: "step-2", content: "Centauri\r\nFTABHarvest\r\nRustDesk-501\r\n" },
    ]);

    // Step usage summed for this invocation (12281 + 12513 input, 133 + 56 output).
    expect(parsed.usage).toEqual({ inputTokens: 24794, outputTokens: 189, cachedInputTokens: 0 });
    expect(parsed.usageBasis).toBe("per_run");
  });

  it("parses a resumed conversation: keeps the resumed id and reports only this run's step usage", () => {
    const parsed = parseAntigravityStreamJson(RESUME_FIXTURE);

    expect(parsed.sessionId).toBe("023827b5-e2cb-4967-b61c-2488666ca7af");
    // Resumed init events carry no model.
    expect(parsed.model).toBeNull();
    expect(parsed.summary).toBe("3");
    expect(parsed.numTurns).toBe(2);
    expect(parsed.toolCalls).toEqual([]);
    // result.usage (37658) is conversation-cumulative; the step usage (12864) is this run's.
    expect(parsed.usage).toEqual({ inputTokens: 12864, outputTokens: 95, cachedInputTokens: 0 });
    expect(parsed.usageBasis).toBe("per_run");
  });

  it("maps a non-SUCCESS result to an error message from result.error", () => {
    const parsed = parseAntigravityStreamJson(ERROR_MODEL_FIXTURE);

    expect(parsed.status).toBe("ERROR");
    expect(parsed.sessionId).toBeNull();
    expect(parsed.errorMessage).toMatch(/^invalid model selection/);
    expect(parsed.errorMessage).toContain("no-such-model-xyz");
    expect(parsed.summary).toBe("");
    expect(parsed.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    expect(parsed.usageBasis).toBe("session_cumulative");
  });

  it("falls back to result.usage (session_cumulative) when no step carried usage", () => {
    const stdout = [
      JSON.stringify({ event: "init", conversation_id: "conv-1", init: { model: "m", cwd: "/tmp", tools: [] } }),
      JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "hi\n" } }),
      JSON.stringify({ event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", response: "hi\n", num_turns: 1, usage: { input_tokens: 10, output_tokens: 4, thinking_tokens: 2, cache_read_tokens: 3, total_tokens: 14 } } }),
    ].join("\n");

    const parsed = parseAntigravityStreamJson(stdout);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 3 });
    expect(parsed.usageBasis).toBe("session_cumulative");
  });

  it("never drops thinking tokens when output_tokens is reported below them", () => {
    const stdout = JSON.stringify({
      event: "step_update",
      step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "x", usage: { input_tokens: 1, output_tokens: 2, thinking_tokens: 9 } },
    });
    expect(parseAntigravityStreamJson(stdout).usage).toEqual({ inputTokens: 1, outputTokens: 9, cachedInputTokens: 0 });
  });

  it("joins streamed text deltas of one step and prefers result.response as the summary", () => {
    const stdout = [
      JSON.stringify({ event: "init", conversation_id: "conv-2", init: { model: "m", cwd: "/tmp", tools: [] } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Let me " } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "look.\n" } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "/tmp/a" } } } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "/tmp/a" }, output: "contents" } } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "## Update\n\n- done\n" } }),
    ].join("\n");

    const parsed = parseAntigravityStreamJson(stdout);
    // No result event: last agent_response wins, not the intermediate "Let me look."
    expect(parsed.summary).toBe("## Update\n\n- done");
    expect(parsed.status).toBeNull();
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolResults).toEqual([{ toolCallId: "step-2", content: "contents" }]);

    const withResult = parseAntigravityStreamJson(
      `${stdout}\n${JSON.stringify({ event: "result", result: { conversation_id: "conv-2", status: "SUCCESS", response: "Final answer\n", num_turns: 1 } })}`,
    );
    expect(withResult.summary).toBe("Final answer");
  });

  it("registers a tool call from a DONE-only tool step", () => {
    const stdout = JSON.stringify({
      event: "step_update",
      step_update: { step_index: 4, state: "DONE", step_type: "tool", tool_name: "grep_search", tool_info: { name: "grep_search", parameters: { Query: "x" }, output: "" } },
    });
    const parsed = parseAntigravityStreamJson(stdout);
    expect(parsed.toolCalls).toEqual([{ id: "step-4", name: "grep_search", arguments: { Query: "x" } }]);
    expect(parsed.toolResults).toEqual([{ toolCallId: "step-4", content: "" }]);
  });

  it("skips malformed lines without failing the parse", () => {
    const stdout = [
      "not json at all",
      JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "visible" } }),
      "{broken json",
      "",
    ].join("\n");

    const parsed = parseAntigravityStreamJson(stdout);
    expect(parsed.summary).toBe("visible");
    expect(parsed.sessionId).toBeNull();
  });

  it("buildAntigravityRunSummary prefers the final response, else the last non-empty step", () => {
    expect(buildAntigravityRunSummary("final\n", ["a", "b"])).toBe("final");
    expect(buildAntigravityRunSummary("", ["first", "second", ""])).toBe("second");
    expect(buildAntigravityRunSummary(null, [])).toBe("");
  });
});

describe("parseAntigravityJsonOutput", () => {
  it("parses the --output-format json fixture", () => {
    const parsed = parseAntigravityJsonOutput(JSON_OUTPUT_FIXTURE);
    expect(parsed).toEqual({
      sessionId: "eb86ae71-044b-41bc-a32c-ae60b9f35145",
      status: "SUCCESS",
      response: "hello\n",
      usage: { inputTokens: 12261, outputTokens: 23, cachedInputTokens: 0 },
      errorMessage: null,
    });
  });

  it("surfaces result.error for a non-SUCCESS status", () => {
    const parsed = parseAntigravityJsonOutput(
      JSON.stringify({ conversation_id: "", status: "ERROR", response: "", error: "invalid model selection" }),
    );
    expect(parsed.status).toBe("ERROR");
    expect(parsed.errorMessage).toBe("invalid model selection");
  });

  it("returns an empty result for non-JSON stdout", () => {
    expect(parseAntigravityJsonOutput("nope")).toEqual({
      sessionId: null,
      status: null,
      response: "",
      usage: null,
      errorMessage: null,
    });
  });
});

describe("extractAntigravityRuntimeEvents", () => {
  it("maps agent_response deltas to assistant snippet events", () => {
    const line = JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Here is my plan" } });
    expect(extractAntigravityRuntimeEvents(line)).toEqual([
      { eventType: "assistant", message: "Here is my plan", payload: { content: "Here is my plan" } },
    ]);
  });

  it("maps ACTIVE tool steps to tool_call events and ignores DONE results", () => {
    const active = JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: {} } } });
    const done = JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: {}, output: "ok" } } });
    expect(extractAntigravityRuntimeEvents(active)).toEqual([{ eventType: "tool_call", payload: { toolName: "run_command" } }]);
    expect(extractAntigravityRuntimeEvents(done)).toEqual([]);
  });

  it("emits nothing for init, result, whitespace-only deltas, and malformed lines", () => {
    expect(extractAntigravityRuntimeEvents(TOOL_CALL_FIXTURE.split("\n")[0])).toEqual([]);
    expect(extractAntigravityRuntimeEvents(JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "\n" } }))).toEqual([]);
    expect(extractAntigravityRuntimeEvents(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }))).toEqual([]);
    expect(extractAntigravityRuntimeEvents("not json")).toEqual([]);
  });

  it("emits one tool_call + one assistant event across the whole tool-call fixture", () => {
    const events = TOOL_CALL_FIXTURE.split("\n").flatMap((line) => extractAntigravityRuntimeEvents(line));
    expect(events.map((event) => event.eventType)).toEqual(["tool_call", "assistant"]);
  });
});

describe("conversation / auth / network classification", () => {
  it("detects the not-found warning agy prints for an unknown --conversation id", () => {
    expect(detectAntigravityConversationNotFound(CONVERSATION_NOT_FOUND_STDERR)).toBe("00000000-0000-0000-0000-000000000000");
    expect(detectAntigravityConversationNotFound("all good")).toBeNull();
    expect(isAntigravitySessionUnrecoverableError("", CONVERSATION_NOT_FOUND_STDERR)).toBe(true);
    expect(isAntigravitySessionUnrecoverableError("", "Some other error")).toBe(false);
  });

  it("flags auth failures only from stderr / structured error text", () => {
    expect(detectAntigravityAuthRequired({ stderr: "error: not signed in. Run agy to sign in." }).requiresAuth).toBe(true);
    expect(detectAntigravityAuthRequired({ stderr: "", errorMessage: "401 Unauthorized" }).requiresAuth).toBe(true);
    expect(detectAntigravityAuthRequired({ stderr: "", errorMessage: null }).requiresAuth).toBe(false);
    expect(detectAntigravityAuthRequired({ stderr: "warning: conversation \"x\" not found" }).requiresAuth).toBe(false);
  });

  it("matches transient network errors", () => {
    expect(isAntigravityTransientNetworkError("", "dial tcp: lookup api.example: no such host")).toBe(true);
    expect(isAntigravityTransientNetworkError("", "Error: getaddrinfo ENOTFOUND host")).toBe(true);
    expect(isAntigravityTransientNetworkError("", "Some other error")).toBe(false);
  });
});
