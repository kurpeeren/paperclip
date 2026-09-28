import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const ensureRuntimeInstalledMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const prepareRuntimeMock = vi.hoisted(() => vi.fn(async () => ({
  workspaceRemoteDir: null,
  restoreWorkspace: async () => {},
})));
const resolveCommandForLogsMock = vi.hoisted(() => vi.fn(async () => "agy"));
const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: () => false,
  adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) => cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown, _cwd: string) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  adapterExecutionTargetUsesManagedHome: () => false,
  adapterExecutionTargetUsesPaperclipBridge: () => false,
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetRuntimeCommandInstalled: ensureRuntimeInstalledMock,
  prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) => executionTarget ?? { kind: "local" },
  readAdapterExecutionTargetHomeDir: async () => null,
  resolveAdapterExecutionTargetCommandForLogs: resolveCommandForLogsMock,
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: runProcessMock,
  runAdapterExecutionTargetShellCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  startAdapterExecutionTargetPaperclipBridge: async () => null,
}));

import { execute } from "./execute.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const TOOL_CALL_STDOUT = await fs.readFile(path.join(fixturesDir, "stream-json-tool-call.ndjson"), "utf8");
const RESUME_STDOUT = await fs.readFile(path.join(fixturesDir, "stream-json-resume.ndjson"), "utf8");
const ERROR_MODEL_STDOUT = await fs.readFile(path.join(fixturesDir, "stream-json-error-model.ndjson"), "utf8");
const NOT_FOUND_STDERR = await fs.readFile(path.join(fixturesDir, "stderr-conversation-not-found.txt"), "utf8");

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-local-"));
  tempRoots.push(root);
  return root;
}

function makeContext(root: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Antigravity Agent",
      adapterType: "antigravity_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { cwd: root },
    context: {},
    authToken: "run-token",
    onLog: async () => {},
    ...overrides,
  };
}

function simpleStdout(conversationId: string, text: string): string {
  return [
    JSON.stringify({ event: "init", conversation_id: conversationId, init: { model: "gemini-3.8-flash-medium", cwd: "/tmp", tools: [] } }),
    JSON.stringify({ event: "step_update", step_update: { conversation_id: conversationId, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: `${text}\n`, usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 1, total_tokens: 15 } } }),
    JSON.stringify({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: `${text}\n`, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 1, total_tokens: 15 } } }),
  ].join("\n");
}

describe("antigravity_local execute", () => {
  beforeEach(() => {
    ensureRuntimeInstalledMock.mockClear();
    ensureCommandMock.mockClear();
    prepareRuntimeMock.mockClear();
    resolveCommandForLogsMock.mockClear();
    runProcessMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("runs agy headless with stream-json, skips permissions by default, and captures the conversation id", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    let seenEnv: Record<string, string> = {};
    let seenCommand = "";
    runProcessMock.mockImplementation(async (_runId, _target, command, args, options) => {
      seenCommand = command;
      seenArgs = args;
      seenEnv = options.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: TOOL_CALL_STDOUT, stderr: "" };
    });

    const result = await execute(makeContext(root, { config: { cwd: root, model: "gemini-3.8-flash-medium" } }));

    expect(seenCommand).toBe("agy");
    expect(seenArgs.slice(0, 5)).toEqual([
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--model",
      "gemini-3.8-flash-medium",
    ]);
    expect(seenArgs).not.toContain("--conversation");
    expect(seenArgs).not.toContain("--effort");
    // The prompt must be the LAST argument.
    expect(seenArgs[seenArgs.length - 2]).toBe("-p");
    expect(seenArgs[seenArgs.length - 1]).toContain("Paperclip runtime note");
    expect(seenEnv.CI).toBe("1");
    expect(seenEnv.NO_COLOR).toBe("1");
    expect(seenEnv.TERM).toBe("dumb");
    expect(seenEnv.PAPERCLIP_API_KEY).toBe("run-token");
    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      errorCode: null,
      sessionId: "023827b5-e2cb-4967-b61c-2488666ca7af",
      sessionDisplayId: "023827b5-e2cb-4967-b61c-2488666ca7af",
      provider: "google",
      biller: "antigravity",
      billingType: "subscription",
      costUsd: null,
      model: "gemini-3.8-flash-medium",
      usage: { inputTokens: 24794, outputTokens: 189, cachedInputTokens: 0 },
      usageBasis: "per_run",
    });
    expect(result.summary).toContain("The command printed **3** lines");
    expect(result.sessionParams).toMatchObject({ sessionId: "023827b5-e2cb-4967-b61c-2488666ca7af", cwd: root });
    expect(result.resultJson).toMatchObject({
      status: "SUCCESS",
      numTurns: 1,
      toolCalls: [{ id: "step-2", name: "run_command" }],
      toolResults: [{ toolCallId: "step-2" }],
    });
  });

  it("forwards streamed stdout lines to onEvent as tool_call + assistant runtime events", async () => {
    const root = await makeTempRoot();
    const events: Array<{ eventType: string; message?: string; payload?: Record<string, unknown> }> = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      // Deliver stdout in awkward chunks to exercise the line buffer.
      const mid = Math.floor(TOOL_CALL_STDOUT.length / 3);
      await options.onLog("stdout", TOOL_CALL_STDOUT.slice(0, mid));
      await options.onLog("stdout", TOOL_CALL_STDOUT.slice(mid));
      return { exitCode: 0, signal: null, timedOut: false, stdout: TOOL_CALL_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, {
      onEvent: async (event) => {
        events.push({ eventType: event.eventType, message: event.message, payload: event.payload });
      },
    }));

    expect(events).toEqual([
      { eventType: "tool_call", message: undefined, payload: { toolName: "run_command" } },
      expect.objectContaining({ eventType: "assistant", message: expect.stringContaining("The command printed") }),
    ]);
  });

  it("resumes with --conversation when the stored session cwd matches, and applies --effort + extraArgs", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: RESUME_STDOUT, stderr: "" };
    });

    const result = await execute(makeContext(root, {
      config: { cwd: root, effort: "high", extraArgs: ["--sandbox"], dangerouslySkipPermissions: false },
      runtime: {
        sessionId: "023827b5-e2cb-4967-b61c-2488666ca7af",
        sessionParams: { sessionId: "023827b5-e2cb-4967-b61c-2488666ca7af", cwd: root },
        sessionDisplayId: "023827b5-e2cb-4967-b61c-2488666ca7af",
        taskKey: null,
      },
    }));

    expect(seenArgs).not.toContain("--dangerously-skip-permissions");
    expect(seenArgs).toContain("--conversation");
    expect(seenArgs[seenArgs.indexOf("--conversation") + 1]).toBe("023827b5-e2cb-4967-b61c-2488666ca7af");
    expect(seenArgs[seenArgs.indexOf("--effort") + 1]).toBe("high");
    expect(seenArgs).toContain("--sandbox");
    expect(seenArgs.indexOf("--sandbox")).toBeLessThan(seenArgs.indexOf("-p"));
    expect(result.sessionId).toBe("023827b5-e2cb-4967-b61c-2488666ca7af");
    expect(result.usage).toEqual({ inputTokens: 12864, outputTokens: 95, cachedInputTokens: 0 });
    expect(result.summary).toBe("3");
  });

  it("does not resume when the stored session cwd differs", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: simpleStdout("conv-new", "ok"), stderr: "" };
    });

    const result = await execute(makeContext(root, {
      runtime: {
        sessionId: "conv-old",
        sessionParams: { sessionId: "conv-old", cwd: path.join(root, "elsewhere") },
        sessionDisplayId: "conv-old",
        taskKey: null,
      },
    }));

    expect(seenArgs).not.toContain("--conversation");
    expect(result.sessionId).toBe("conv-new");
  });

  it("adopts the fresh conversation id when agy reports the stored one was not found", async () => {
    const root = await makeTempRoot();
    const logs: string[] = [];
    runProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: simpleStdout("4108bd9d-bdf6-4ab0-ba02-ea6583ab01e2", "Hello!"),
      stderr: NOT_FOUND_STDERR,
    });

    const result = await execute(makeContext(root, {
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      runtime: {
        sessionId: "00000000-0000-0000-0000-000000000000",
        sessionParams: { sessionId: "00000000-0000-0000-0000-000000000000", cwd: root },
        sessionDisplayId: "00000000-0000-0000-0000-000000000000",
        taskKey: null,
      },
    }));

    expect(runProcessMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("4108bd9d-bdf6-4ab0-ba02-ea6583ab01e2");
    expect(logs.join("")).toContain("was not found; agy started a fresh conversation");
  });

  it("retries with a fresh conversation when a resume fails hard", async () => {
    const root = await makeTempRoot();
    const seenArgs: string[][] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs.push(args);
      return seenArgs.length === 1
        ? { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "error: conversation \"conv-old\" not found" }
        : { exitCode: 0, signal: null, timedOut: false, stdout: simpleStdout("conv-fresh", "done"), stderr: "" };
    });

    const result = await execute(makeContext(root, {
      runtime: {
        sessionId: "conv-old",
        sessionParams: { sessionId: "conv-old", cwd: root },
        sessionDisplayId: "conv-old",
        taskKey: null,
      },
    }));

    expect(seenArgs).toHaveLength(2);
    expect(seenArgs[0]).toContain("--conversation");
    expect(seenArgs[1]).not.toContain("--conversation");
    expect(result.sessionId).toBe("conv-fresh");
    expect(result.exitCode).toBe(0);
  });

  it("reports a structured ERROR result as a failed run with the agy error text", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: ERROR_MODEL_STDOUT,
      stderr: "error: invalid model selection",
    });

    const result = await execute(makeContext(root, { config: { cwd: root, model: "no-such-model-xyz" } }));

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toMatch(/^invalid model selection/);
    expect(result.errorCode).toBeNull();
    expect(result.sessionId).toBeNull();
    expect(result.resultJson).toMatchObject({ status: "ERROR", stderr: "error: invalid model selection" });
  });

  it("fails a run whose result status is not SUCCESS even when the process exits 0", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({ event: "result", result: { conversation_id: "c", status: "CANCELLED", response: "", error: "cancelled by user" } }),
      stderr: "",
    });

    const result = await execute(makeContext(root));
    expect(result.errorMessage).toBe("cancelled by user");
  });

  it("classifies sign-in failures with antigravity_auth_required", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValue({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "error: not signed in" });

    const result = await execute(makeContext(root));
    expect(result.errorCode).toBe("antigravity_auth_required");
  });

  it("prepends the instructions file to the prompt and adds its directory via --add-dir", async () => {
    const root = await makeTempRoot();
    const instructionsDir = path.join(root, "agent");
    await fs.mkdir(instructionsDir, { recursive: true });
    const instructionsFilePath = path.join(instructionsDir, "AGENTS.md");
    await fs.writeFile(instructionsFilePath, "# Be helpful\n", "utf8");
    let seenArgs: string[] = [];
    let meta: Record<string, unknown> | null = null;
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: simpleStdout("conv-1", "ok"), stderr: "" };
    });

    await execute(makeContext(root, {
      config: { cwd: root, instructionsFilePath },
      onMeta: async (value) => {
        meta = value as unknown as Record<string, unknown>;
      },
    }));

    const prompt = seenArgs[seenArgs.length - 1];
    expect(prompt.startsWith("# Be helpful\n")).toBe(true);
    expect(prompt).toContain(`The above agent instructions were loaded from ${instructionsFilePath}.`);
    expect(seenArgs[seenArgs.indexOf("--add-dir") + 1]).toBe(instructionsDir);
    expect(meta).toMatchObject({ adapterType: "antigravity_local", command: "agy", cwd: root });
    const commandArgs = (meta as Record<string, unknown> | null)?.commandArgs as string[];
    expect(commandArgs[commandArgs.length - 1]).toMatch(/^<prompt \d+ chars>$/);
  });

  it("reports a timeout without a session-clearing error", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValue({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" });

    const result = await execute(makeContext(root, { config: { cwd: root, timeoutSec: 5 } }));
    expect(result).toMatchObject({ timedOut: true, errorMessage: "Timed out after 5s", errorCode: null });
  });
});
