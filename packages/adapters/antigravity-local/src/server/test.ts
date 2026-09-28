import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { resolveAntigravityEffort } from "../index.js";
import { detectAntigravityAuthRequired, parseAntigravityJsonOutput } from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

/**
 * Detect Antigravity sign-in material on the local host. agy 1.2.12 stores
 * its Google OAuth token at $ANTIGRAVITY_HOME/antigravity-oauth-token
 * (default ~/.gemini/antigravity-cli).
 */
async function detectLocalAntigravityAuth(env: Record<string, string>): Promise<string | null> {
  const antigravityHome =
    (isNonEmpty(env.ANTIGRAVITY_HOME) && env.ANTIGRAVITY_HOME.trim()) ||
    (isNonEmpty(process.env.ANTIGRAVITY_HOME) && process.env.ANTIGRAVITY_HOME.trim()) ||
    path.join(
      (isNonEmpty(env.HOME) && env.HOME.trim()) || os.homedir(),
      ".gemini",
      "antigravity-cli",
    );
  const tokenPath = path.join(antigravityHome, "antigravity-oauth-token");
  if (await pathExists(tokenPath)) {
    return `${tokenPath} (Antigravity Google sign-in)`;
  }
  return null;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "agy");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `antigravity-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "antigravity_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "antigravity_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "antigravity_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "antigravity_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "antigravity_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install the Antigravity CLI (agy) on the target host and make sure it is on PATH, or set `command` to its absolute path.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "antigravity_cwd_invalid" && check.code !== "antigravity_command_unresolvable");

  if (canRunProbe && commandLooksLike(command, "agy")) {
    const versionProbe = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      ["--version"],
      {
        cwd,
        env,
        timeoutSec: 15,
        graceSec: 5,
        onLog: async () => {},
      },
    );
    const versionLine = firstNonEmptyLine(versionProbe.stdout) || firstNonEmptyLine(versionProbe.stderr);
    if (!versionProbe.timedOut && (versionProbe.exitCode ?? 1) === 0) {
      checks.push({
        code: "antigravity_version_detected",
        level: "info",
        message: `Antigravity CLI detected${versionLine ? `: ${versionLine.replace(/\s+/g, " ").trim().slice(0, 120)}` : "."}`,
      });
    } else {
      checks.push({
        code: "antigravity_version_probe_failed",
        level: "warn",
        message: versionProbe.timedOut
          ? "`agy --version` timed out."
          : "`agy --version` did not exit cleanly.",
        ...(versionLine ? { detail: versionLine } : {}),
      });
    }
  }

  const authSource = targetIsRemote ? null : await detectLocalAntigravityAuth(env);
  if (authSource) {
    checks.push({
      code: "antigravity_auth_detected",
      level: "info",
      message: "Antigravity sign-in detected.",
      detail: `Source: ${authSource}.`,
    });
  } else if (!targetIsRemote) {
    checks.push({
      code: "antigravity_auth_missing",
      level: "warn",
      message: "No Antigravity sign-in detected.",
      hint: "Run `agy` interactively once on the host and complete the Google sign-in, then retry the probe.",
    });
  }

  if (canRunProbe) {
    if (!commandLooksLike(command, "agy")) {
      checks.push({
        code: "antigravity_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `agy`.",
        detail: command,
        hint: "Use the `agy` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const model = asString(config.model, "").trim();
      const effort = resolveAntigravityEffort(asString(config.effort, ""));
      const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 60));
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--output-format", "json", "--dangerously-skip-permissions"];
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("-p", "Respond with hello.");

      const probe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: helloProbeTimeoutSec,
          graceSec: 5,
          onLog: async () => {},
        },
      );
      const parsed = parseAntigravityJsonOutput(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authMeta = detectAntigravityAuthRequired({
        stderr: probe.stderr,
        errorMessage: parsed.errorMessage,
      });

      if (probe.timedOut) {
        checks.push({
          code: "antigravity_hello_probe_timed_out",
          level: "warn",
          message: "Antigravity hello probe timed out.",
          hint: "Retry the probe. If this persists, verify `agy --output-format json -p \"Respond with hello.\"` works from this directory manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0 && parsed.status === "SUCCESS") {
        const summary = parsed.response.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "antigravity_hello_probe_passed" : "antigravity_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Antigravity hello probe succeeded."
            : "Antigravity probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
              hint: "Try `agy --output-format json -p \"Respond with hello.\"` manually to inspect full output.",
            }),
        });
      } else if (authMeta.requiresAuth) {
        checks.push({
          code: "antigravity_hello_probe_auth_required",
          level: "warn",
          message: "Antigravity CLI is installed, but sign-in is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `agy` interactively on the host, complete the Google sign-in, then retry the probe.",
        });
      } else {
        checks.push({
          code: "antigravity_hello_probe_failed",
          level: "error",
          message: "Antigravity hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `agy --output-format json -p \"Respond with hello.\"` manually in this working directory to debug.",
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
