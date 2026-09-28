import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const ensureDirectoryMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetDirectory: ensureDirectoryMock,
  resolveAdapterExecutionTargetCwd: (_target: unknown, configuredCwd: string, fallbackCwd: string) =>
    configuredCwd || fallbackCwd,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

import { testEnvironment } from "./test.js";

const HELLO_JSON = JSON.stringify({
  conversation_id: "eb86ae71-044b-41bc-a32c-ae60b9f35145",
  status: "SUCCESS",
  response: "hello\n",
  duration_seconds: 3.4,
  num_turns: 1,
  usage: { input_tokens: 12261, output_tokens: 23, thinking_tokens: 22, cache_read_tokens: 0, total_tokens: 12284 },
});

describe("antigravity_local testEnvironment", () => {
  beforeEach(() => {
    ensureDirectoryMock.mockClear();
    ensureCommandMock.mockClear();
    runProcessMock.mockReset();
    // Point auth detection at a directory that does not exist so hosts with a
    // real agy sign-in do not change the outcome.
    vi.stubEnv("ANTIGRAVITY_HOME", "/nonexistent/antigravity-home");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports a working version + hello probe and warns about missing sign-in", async () => {
    runProcessMock
      .mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, stdout: "1.2.12\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, stdout: HELLO_JSON, stderr: "" });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "antigravity_local",
      config: { command: "agy", cwd: "/tmp/project", model: "gemini-3.8-flash-medium", effort: "low" },
    });

    expect(result.status).toBe("warn");
    expect(result.checks.map((check: { code: string }) => check.code)).toEqual(
      expect.arrayContaining([
        "antigravity_command_resolvable",
        "antigravity_version_detected",
        "antigravity_auth_missing",
        "antigravity_hello_probe_passed",
      ]),
    );
    expect(runProcessMock).toHaveBeenNthCalledWith(1, expect.any(String), null, "agy", ["--version"], expect.any(Object));
    expect(runProcessMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      null,
      "agy",
      ["--output-format", "json", "--dangerously-skip-permissions", "--model", "gemini-3.8-flash-medium", "--effort", "low", "-p", "Respond with hello."],
      expect.any(Object),
    );
  });

  it("classifies a non-SUCCESS probe result as a failure with the structured error", async () => {
    runProcessMock
      .mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, stdout: "1.2.12\n", stderr: "" })
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ conversation_id: "", status: "ERROR", response: "", error: "invalid model selection (--model \"nope\")" }),
        stderr: "error: invalid model selection (--model \"nope\")",
      });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "antigravity_local",
      config: { command: "agy", cwd: "/tmp/project", model: "nope" },
    });

    expect(result.status).toBe("fail");
    const failed = result.checks.find((check: { code: string }) => check.code === "antigravity_hello_probe_failed");
    expect(failed?.detail).toContain("invalid model selection");
  });

  it("classifies sign-in errors as auth-required warnings", async () => {
    runProcessMock
      .mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, stdout: "1.2.12\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "error: not signed in" });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "antigravity_local",
      config: { command: "agy", cwd: "/tmp/project" },
    });

    expect(result.status).toBe("warn");
    expect(result.checks.map((check: { code: string }) => check.code)).toContain("antigravity_hello_probe_auth_required");
  });

  it("skips the probes for a custom command name", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "antigravity_local",
      config: { command: "/opt/bin/agy-wrapper", cwd: "/tmp/project" },
    });

    expect(runProcessMock).not.toHaveBeenCalled();
    expect(result.checks.map((check: { code: string }) => check.code)).toContain(
      "antigravity_hello_probe_skipped_custom_command",
    );
  });
});
