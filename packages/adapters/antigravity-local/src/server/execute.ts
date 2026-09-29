import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  joinPromptSections,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolveLegacyPaperclipDesiredSkillNames,
  parseObject,
  renderTemplate,
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
  selectInitialCommunicationGuidance,
  isPaperclipRecoveryWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { resolveAntigravityEffort } from "../index.js";
import {
  describeAntigravityFailure,
  detectAntigravityAuthRequired,
  detectAntigravityConversationNotFound,
  extractAntigravityRuntimeEvents,
  isAntigravitySessionUnrecoverableError,
  isAntigravityTransientNetworkError,
  parseAntigravityStreamJson,
} from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS = true;

/**
 * Wrap `onLog` so each complete agy stream-json stdout line is also mapped to
 * `onEvent` runtime events (assistant snippet, tool name). This keeps the raw
 * run log intact while lighting up the issue-thread activity indicator, which
 * reads `currentToolName` / `lastAssistantSnippet` / `lastEventAt` derived from
 * `onEvent` rather than from the raw log stream. Stdout arrives in arbitrary
 * chunks, so lines are buffered and split on newlines. `flush` must be called
 * once the process exits so the final line reaches `onEvent` even when agy
 * closes stdout without a trailing newline.
 */
function createAntigravityEventForwardingLog(
  onLog: AdapterExecutionContext["onLog"],
  onEvent: AdapterExecutionContext["onEvent"],
): { log: AdapterExecutionContext["onLog"]; flush: () => Promise<void> } {
  if (!onEvent) return { log: onLog, flush: async () => {} };
  let buffer = "";
  const emitLine = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (!line) return;
    for (const event of extractAntigravityRuntimeEvents(line)) {
      await onEvent({ eventType: event.eventType, stream: "stdout", message: event.message, payload: event.payload });
    }
  };
  return {
    log: async (stream, chunk) => {
      await onLog(stream, chunk);
      if (stream !== "stdout") return;
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        await emitLine(line);
      }
    },
    flush: async () => {
      const remaining = buffer;
      buffer = "";
      await emitLine(remaining);
    },
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

/**
 * Headless-safe environment for unattended `agy -p` runs. CI=1 and TERM=dumb
 * keep agy from probing for a TTY, NO_COLOR=1 keeps stderr parseable.
 * User-configured values always win.
 */
export function buildAntigravityHeadlessEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  if (!next.CI?.trim()) next.CI = "1";
  if (!next.NO_COLOR?.trim()) next.NO_COLOR = "1";
  if (!next.TERM?.trim()) next.TERM = "dumb";
  return next;
}

function buildAntigravityRuntimeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...buildAntigravityHeadlessEnv(env) })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!hasNonEmptyEnvValue(env, "PAPERCLIP_API_URL") || !hasNonEmptyEnvValue(env, "PAPERCLIP_API_KEY")) return "";
  return [
    "Paperclip API access note:",
    "Use shell commands with curl to make Paperclip API requests when needed.",
    "Include X-Paperclip-Run-Id on mutating requests.",
    "",
    "",
  ].join("\n");
}

/**
 * agy has no native skills flag. The per-run skills directory is exposed via
 * `--add-dir` (so the agent may read it) and announced in the prompt so the
 * agent knows the skills exist and where to find each SKILL.md.
 */
function renderSkillsNote(skillsDir: string | null, skillNames: string[]): string {
  if (!skillsDir || skillNames.length === 0) return "";
  return [
    "Paperclip skills note:",
    `The following Paperclip skills are available under ${skillsDir} (one folder per skill, each containing a SKILL.md): ${skillNames.join(", ")}.`,
    "Read a skill's SKILL.md before relying on it. This directory is readable via --add-dir.",
    "",
    "",
  ].join("\n");
}

async function buildAntigravitySkillsDir(
  config: Record<string, unknown>,
): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-skills-"));
  const target = path.join(tmp, "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolveLegacyPaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return target;
}

function readSkipPermissions(config: Record<string, unknown>): boolean {
  return typeof config.dangerouslySkipPermissions === "boolean"
    ? config.dangerouslySkipPermissions
    : DEFAULT_ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onEvent, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "agy");
  const model = asString(config.model, "").trim();
  const effort = resolveAntigravityEffort(asString(config.effort, ""));
  const skipPermissions = readSkipPermissions(config);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
      (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
    )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const skillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, skillEntries);
  const envConfig = parseObject(config.env);

  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const runtimeEnv = buildAntigravityRuntimeEnv(env);
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 20);
  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
  });
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
    installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
    timeoutSec,
  });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let localSkillsDir: string | null = null;
  let remoteSkillsDir: string | null = null;
  let remoteRuntimeRootDir: string | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

  if (executionTargetIsRemote) {
    try {
      localSkillsDir = await buildAntigravitySkillsDir(config);
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace and Antigravity runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "antigravity",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
        detectCommand: command,
        onProgress: (line) => onLog("stdout", line),
        onRuntimeProgress: ctx.onRuntimeProgress,
        assets: [{
          key: "skills",
          localDir: localSkillsDir,
          followSymlinks: true,
        }],
      });
      restoreRemoteWorkspace = () =>
        preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog("stdout", line));
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
      refreshPaperclipWorkspaceEnvForExecution({
        env,
        envConfig,
        workspaceCwd: effectiveWorkspaceCwd,
        workspaceSource,
        workspaceId,
        workspaceRepoUrl,
        workspaceRepoRef,
        workspaceHints,
        agentHome,
        executionTargetIsRemote,
        executionCwd: effectiveExecutionCwd,
      });
      remoteRuntimeRootDir = preparedExecutionTargetRuntime.runtimeRootDir;
      const managedHome = adapterExecutionTargetUsesManagedHome(executionTarget);
      const managedRemoteHomeDir =
        managedHome && preparedExecutionTargetRuntime.runtimeRootDir
          ? preparedExecutionTargetRuntime.runtimeRootDir
          : null;
      if (managedRemoteHomeDir) {
        env.HOME = managedRemoteHomeDir;
      }
      if (desiredSkillNames.length > 0 && preparedExecutionTargetRuntime.assetDirs.skills) {
        remoteSkillsDir = preparedExecutionTargetRuntime.assetDirs.skills;
      }
    } catch (error) {
      await Promise.allSettled([
        restoreRemoteWorkspace?.(),
        localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
      ]);
      throw error;
    }
  }
  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
  if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(executionTarget)) {
    paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId,
      target: runtimeExecutionTarget,
      runtimeRootDir: remoteRuntimeRootDir,
      adapterKey: "antigravity",
      timeoutSec,
      hostApiToken: env.PAPERCLIP_API_KEY,
      onLog,
    });
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
    }
  }

  // Local runs stage desired skills into a dedicated per-run directory that is
  // exposed to agy via `--add-dir` (see buildArgs) and announced in the prompt,
  // so skills load without touching the operator's Antigravity install.
  if (!executionTargetIsRemote && desiredSkillNames.length > 0) {
    localSkillsDir = await buildAntigravitySkillsDir(config);
    await onLog(
      "stderr",
      `[paperclip] Prepared ${desiredSkillNames.length} Antigravity skill(s) for --add-dir delivery.\n`,
    );
  }
  const effectiveSkillsDir = executionTargetIsRemote ? remoteSkillsDir : localSkillsDir;

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Antigravity conversation "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote conversation.\n`,
    );
  } else if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Antigravity conversation "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}. ` +
        `This base directory is authoritative for sibling instruction files such as ` +
        `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const commandNotes = (() => {
    const notes: string[] = ["Prompt is passed to Antigravity via -p (last argument) for non-interactive execution."];
    notes.push("Added --output-format stream-json for structured headless output.");
    if (skipPermissions) {
      notes.push("Added --dangerously-skip-permissions so unattended runs auto-approve tool calls.");
    }
    if (effort) notes.push(`Added --effort ${effort}.`);
    notes.push("Set headless env (CI=1, NO_COLOR=1, TERM=dumb) so unattended runs never wait on a TTY.");
    if (effectiveSkillsDir) {
      notes.push(`Exposing ${desiredSkillNames.length} desired skill(s) via --add-dir ${effectiveSkillsDir} and a prompt note.`);
    }
    if (!executionTargetIsRemote && instructionsFilePath) {
      notes.push(`Added --add-dir ${path.dirname(instructionsFilePath)} so sibling instruction files are readable.`);
    }
    if (!instructionsFilePath) return notes;
    if (instructionsPrefix.length > 0) {
      notes.push(
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
      );
      return notes;
    }
    notes.push(
      `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
    );
    return notes;
  })();

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const taskContextNote = context.conversationMode === true
    ? selectPaperclipTaskMarkdown(context, { resumedSession: Boolean(sessionId), includeCommunicationGuidance: false })
    : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    conversationMode: context.conversationMode === true,
    resumedSession: Boolean(sessionId),
    suppressIssueDescription: taskContextNote.length > 0,
  });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? ""
    : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const paperclipEnvNote = renderPaperclipEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);
  const skillsNote = renderSkillsNote(effectiveSkillsDir, desiredSkillNames);
  const basePrompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    taskContextNote,
    sessionHandoffNote,
    paperclipEnvNote,
    apiAccessNote,
    skillsNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: basePrompt.length,
    instructionsChars: instructionsPrefix.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    taskContextChars: taskContextNote.length,
    sessionHandoffChars: sessionHandoffNote.length,
    runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length + skillsNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildArgs = (resumeSessionId: string | null, prompt: string) => {
    const args = ["--output-format", "stream-json"];
    if (skipPermissions) args.push("--dangerously-skip-permissions");
    if (resumeSessionId) args.push("--conversation", resumeSessionId);
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    // Make the agent instructions directory readable so agy can open sibling
    // instruction files (./HEARTBEAT.md, ./SOUL.md, ./TOOLS.md) referenced by
    // the prepended entry file. Local-only: the directory is a host path that
    // is not synced to remote execution targets.
    if (!executionTargetIsRemote && instructionsFilePath) {
      args.push("--add-dir", path.dirname(instructionsFilePath));
    }
    if (effectiveSkillsDir) {
      args.push("--add-dir", effectiveSkillsDir);
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    // agy requires the prompt flag to be the LAST argument.
    args.push("-p", prompt);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const prompt = joinPromptSections([
      selectInitialCommunicationGuidance(context, { resumedSession: Boolean(resumeSessionId) }),
      basePrompt,
    ]);
    const args = buildArgs(resumeSessionId, prompt);
    const invocationEnv = buildAntigravityHeadlessEnv(env);
    const invocationRuntimeEnv = buildAntigravityRuntimeEnv(env);
    const loggedEnv = buildInvocationEnvForLogs(invocationEnv, {
      runtimeEnv: invocationRuntimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });
    if (onMeta) {
      await onMeta({
        adapterType: "antigravity_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandNotes,
        commandArgs: args.map((value, index) => (
          index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value
        )),
        env: loggedEnv,
        prompt,
        promptMetrics: { ...promptMetrics, promptChars: prompt.length },
        context,
      });
    }

    const eventForwarder = createAntigravityEventForwardingLog(onLog, onEvent);
    const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      cwd,
      env: invocationEnv,
      timeoutSec,
      graceSec,
      onSpawn,
      onRuntimeProgress: ctx.onRuntimeProgress,
      onLog: eventForwarder.log,
      runLogTail: paperclipBridge?.runLogTail,
      settleRunDisposition: paperclipBridge?.settleRunDisposition,
    });
    await eventForwarder.flush();
    return {
      proc,
      parsed: parseAntigravityStreamJson(proc.stdout),
    };
  };

  const toResult = (
    attempt: {
      proc: {
        exitCode: number | null;
        signal: string | null;
        timedOut: boolean;
        stdout: string;
        stderr: string;
        errorCode?: string | null;
      };
      parsed: ReturnType<typeof parseAntigravityStreamJson>;
    },
    clearSessionOnMissingSession = false,
    isRetry = false,
  ): AdapterExecutionResult => {
    const authMeta = detectAntigravityAuthRequired({
      stderr: attempt.proc.stderr,
      errorMessage: attempt.parsed.errorMessage,
    });
    const networkUnavailable = isAntigravityTransientNetworkError(attempt.proc.stdout, attempt.proc.stderr);

    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: authMeta.requiresAuth
          ? "antigravity_auth_required"
          : networkUnavailable
            ? "antigravity_network_unavailable"
            : null,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const structuredFailure = describeAntigravityFailure({
      errorMessage: attempt.parsed.errorMessage,
      stderr: attempt.proc.stderr,
    });
    const fallbackErrorMessage =
      parsedError ||
      structuredFailure ||
      stderrLine ||
      (attempt.proc.signal
        ? `Antigravity was terminated by signal ${attempt.proc.signal}`
        : `Antigravity exited with code ${attempt.proc.exitCode ?? -1}`);
    // A null exit code means the process never exited normally (e.g. killed by
    // a signal). Timeouts are handled earlier; treat any other non-zero or
    // null exit as a failure, and also a structured non-SUCCESS result status
    // (agy exits 1 on ERROR today, but the status is the authoritative signal).
    const failed =
      attempt.proc.exitCode === null ||
      attempt.proc.exitCode !== 0 ||
      (attempt.parsed.status !== null && attempt.parsed.status !== "SUCCESS");

    // On retry, don't fall back to old session ID — the old session was stale
    const canFallbackToRuntimeSession = !isRetry;
    const resolvedSessionId = attempt.parsed.sessionId
      ?? (canFallbackToRuntimeSession ? (runtimeSessionId || runtime.sessionId || null) : null);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd: effectiveExecutionCwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        ...(executionTargetIsRemote
          ? {
              remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
            }
          : {}),
      } as Record<string, unknown>)
      : null;
    const resultJson: Record<string, unknown> = {
      toolCalls: attempt.parsed.toolCalls,
      toolResults: attempt.parsed.toolResults,
      ...(attempt.parsed.status ? { status: attempt.parsed.status } : {}),
      ...(attempt.parsed.numTurns !== null ? { numTurns: attempt.parsed.numTurns } : {}),
      ...(failed ? { stderr: attempt.proc.stderr } : {}),
    };

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: failed ? fallbackErrorMessage : null,
      // Forward the transport-level error code from the run-disposition seam
      // first. A lost duplex control channel surfaces the typed
      // `duplex_channel_lost` code before any provider classification.
      errorCode: attempt.proc.errorCode
        ? attempt.proc.errorCode
        : failed && authMeta.requiresAuth
        ? "antigravity_auth_required"
        : failed && networkUnavailable
        ? "antigravity_network_unavailable"
        : null,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "google",
      biller: "antigravity",
      model: attempt.parsed.model || model || null,
      // Antigravity bills through the Google subscription; agy reports no USD
      // cost, so only token usage is recorded.
      billingType: "subscription",
      costUsd: null,
      ...(attempt.parsed.usage ? { usage: attempt.parsed.usage, usageBasis: attempt.parsed.usageBasis } : {}),
      resultJson,
      summary: attempt.parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId);
    if (sessionId) {
      const replaced = detectAntigravityConversationNotFound(initial.proc.stderr);
      if (replaced && (initial.proc.exitCode ?? 0) === 0 && initial.parsed.sessionId && initial.parsed.sessionId !== sessionId) {
        // agy 1.2.12 silently starts a fresh conversation on an unknown id;
        // the parsed init conversation_id already points at the new one.
        await onLog(
          "stdout",
          `[paperclip] Antigravity conversation "${replaced}" was not found; agy started a fresh conversation "${initial.parsed.sessionId}".\n`,
        );
      } else if (
        !initial.proc.timedOut &&
        (initial.proc.exitCode ?? 0) !== 0 &&
        isAntigravitySessionUnrecoverableError(initial.proc.stdout, initial.proc.stderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] Antigravity conversation "${sessionId}" is unavailable; retrying with a fresh conversation.\n`,
        );
        const retry = await runAttempt(null);
        return toResult(retry, true, true);
      }
    }

    return toResult(initial);
  } finally {
    await Promise.all([
      paperclipBridge?.stop(),
      restoreRemoteWorkspace?.(),
      localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
    ]);
  }
}
