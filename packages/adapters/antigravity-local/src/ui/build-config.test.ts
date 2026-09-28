import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildAntigravityLocalConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "antigravity_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildAntigravityLocalConfig", () => {
  it("defaults the model to gemini-3.8-flash-medium and skips permissions when unset", () => {
    const config = buildAntigravityLocalConfig(makeValues());

    expect(config.model).toBe("gemini-3.8-flash-medium");
    expect(config.dangerouslySkipPermissions).toBe(true);
    expect(config.timeoutSec).toBe(0);
    expect(config.graceSec).toBe(15);
    expect(config).not.toHaveProperty("effort");
    expect(config).not.toHaveProperty("maxTurnsPerRun");
  });

  it("persists an explicit model, effort, command, and permission opt-out", () => {
    const config = buildAntigravityLocalConfig(makeValues({
      model: "gemini-3.1-pro-high",
      thinkingEffort: "max",
      command: "/Users/eren/.local/bin/agy",
      dangerouslySkipPermissions: false,
    }));

    expect(config.model).toBe("gemini-3.1-pro-high");
    expect(config.effort).toBe("max");
    expect(config.command).toBe("/Users/eren/.local/bin/agy");
    expect(config.dangerouslySkipPermissions).toBe(false);
  });

  it("persists cwd, instructionsFilePath, and extra args", () => {
    const config = buildAntigravityLocalConfig(makeValues({
      cwd: "/tmp/project",
      instructionsFilePath: "/tmp/project/AGENTS.md",
      extraArgs: "--sandbox, --mode accept-edits",
    }));

    expect(config.cwd).toBe("/tmp/project");
    expect(config.instructionsFilePath).toBe("/tmp/project/AGENTS.md");
    expect(config.extraArgs).toEqual(["--sandbox", "--mode accept-edits"]);
  });

  it("merges legacy env vars with secret bindings", () => {
    const config = buildAntigravityLocalConfig(makeValues({
      envVars: "ANTIGRAVITY_HOME=/opt/agy\n# comment\nINVALID LINE",
      envBindings: {
        SOME_TOKEN: { type: "secret_ref", secretId: "secret-1" },
      },
    }));

    expect(config.env).toEqual({
      ANTIGRAVITY_HOME: { type: "plain", value: "/opt/agy" },
      SOME_TOKEN: { type: "secret_ref", secretId: "secret-1" },
    });
  });
});
