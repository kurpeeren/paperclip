---
title: Antigravity (local)
summary: Google Antigravity CLI (agy) local adapter setup and configuration
---

The `antigravity_local` adapter runs Google's Antigravity CLI (`agy`) locally in headless print mode (`agy --output-format stream-json ... -p <prompt>`). It is a subscription-billed Gemini lane: runs count against the operator's Antigravity plan, so no API key is needed and no USD cost is recorded. Sessions persist across heartbeats through agy's conversation ids, Paperclip skills are exposed per run via `--add-dir`, and the stream-json output is parsed into the run log, tool calls, usage, and summary.

## Prerequisites

- Antigravity CLI installed (`agy` on PATH, or `command` set to its absolute path; verified against agy 1.2.12)
- Signed in: run `agy` interactively once on the host and complete the Google sign-in. The token lives at `~/.gemini/antigravity-cli/antigravity-oauth-token` (override the root with `ANTIGRAVITY_HOME` in the adapter env).

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Antigravity model id passed via `--model`. Defaults to `gemini-3.8-flash-medium`. The thinking tier is part of most ids (`-low` / `-medium` / `-high`); `agy models` lists the current set. |
| `effort` | string | No | Effort tier (`low` \| `medium` \| `high` \| `max`) passed via `--effort`. Omitted when unset. |
| `dangerouslySkipPermissions` | boolean | No | Pass `--dangerously-skip-permissions` so unattended runs auto-approve tool calls. Defaults to `true`. |
| `promptTemplate` | string | No | Prompt used for all runs |
| `instructionsFilePath` | string | No | Markdown instructions file prepended to the prompt. Its directory is made readable via `--add-dir` on local runs so sibling files (`HEARTBEAT.md`, `SOUL.md`, `TOOLS.md`) resolve. |
| `command` | string | No | CLI command override. Defaults to `agy`. |
| `extraArgs` | string[] | No | Additional CLI arguments inserted before the prompt |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `helloProbeTimeoutSec` | number | No | Connection-test probe timeout (default 60) |

`maxTurnsPerRun` is not enforced: agy has no `--max-turns` flag.

## Invocation

```
agy --output-format stream-json [--dangerously-skip-permissions] [--conversation <id>] \
    [--model <model>] [--effort <tier>] [--add-dir <instructions dir>] [--add-dir <skills dir>] \
    [<extraArgs>...] -p <prompt>
```

The prompt is always the last argument (agy requires it). The adapter sets `CI=1`, `NO_COLOR=1`, and `TERM=dumb` unless the adapter env overrides them.

## Sessions

The `conversation_id` from agy's `init` event is stored with the run's cwd. A later heartbeat in the same cwd resumes with `--conversation <id>`; a different cwd starts fresh. agy 1.2.12 does not fail on an unknown id: it prints `warning: conversation "<id>" not found` on stderr and starts a new conversation, whose id then replaces the stored one (the run log notes the swap). A hard resume failure (non-zero exit) is retried once without `--conversation`.

## Usage and billing

Each run reports `usage` summed from agy's per-step `usage` blocks (`input_tokens`, `output_tokens`, `cache_read_tokens`) with `usageBasis: "per_run"`. agy's trailing `result.usage` is conversation-cumulative and is only used, as `session_cumulative`, when no step carried usage. `thinking_tokens` is already included in `output_tokens` (`total_tokens == input + output`). Runs are recorded with `provider: "google"`, `biller: "antigravity"`, `billingType: "subscription"`, and no `costUsd`.

## Skills

Desired Paperclip skills are symlinked into a per-run temporary directory, exposed with `--add-dir`, and announced in the prompt (skill names plus the path to each `SKILL.md`). The Skills page links skills into `~/.gemini/antigravity-cli/paperclip-skills` for visibility; agy has no native skills flag.

## Connection test

The environment test checks the cwd, resolves `agy`, runs `agy --version`, looks for the OAuth token file, then runs `agy --output-format json --dangerously-skip-permissions [--model ...] -p "Respond with hello."` and expects `status: "SUCCESS"` with `hello` in the response.

## Switching an existing agent

```
paperclipai agent update <agentId> --payload-json '{"adapterType":"antigravity_local","adapterConfig":{"cwd":"/abs/path","model":"gemini-3.8-flash-medium","dangerouslySkipPermissions":true,"timeoutSec":0,"graceSec":15}}'
```
