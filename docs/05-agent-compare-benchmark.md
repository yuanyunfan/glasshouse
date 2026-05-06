# 05 - Agent Compare Benchmark

## Status

Idea / Exploration

This is a concept note only. Do not implement this feature yet. The design is
being kept in `docs/` to capture product thinking, constraints, and possible
future architecture. Any implementation should wait for an explicit follow-up
decision that promotes this document to `design-complete` or `in-progress`.

## Background

Glasshouse can capture Claude Code and Codex request logs, tool calls, tool
results, token usage, runtime metadata, and local server events. RFC 04 defines
session-quality audit reports for a single captured session.

This document defines a separate feature: comparing Codex and Claude Code on the
same class of task, with the same repository context and the same verification
standard. The goal is not to answer which agent is generally "smarter"; the goal
is to measure which agent more reliably completes a concrete task under
controlled conditions.

This feature is intentionally a low-frequency experimental calibration tool. It
helps a user learn which agent better fits their personal workflow and task mix,
so they can choose the right tool faster in daily work. It is not meant to run
automatically for every task.

## Goals

1. Create reproducible benchmark tasks from a prompt, repository revision,
   workspace path, context snapshot, and verification commands.
2. Run Codex and Claude Code against the same task in isolated workspaces.
3. Capture both agent runs through Glasshouse without mixing their logs,
   worktrees, or generated artifacts.
4. Run the same verification commands for each agent after it finishes.
5. Generate a session-quality audit for each agent run using RFC 04.
6. Produce an agent-comparison dashboard with evidence-backed differences in
   completion, verification, code quality, tool use, context efficiency, safety,
   and communication.
7. Preserve source logs and benchmark inputs read-only after the run starts.
8. Produce a personal agent-fit profile that summarizes which task types Codex
   or Claude Code appears better suited for in this user's workflow.

## Non-goals

- Comparing arbitrary historical sessions as if they were fair head-to-head
  benchmarks. Different prompts, context, time, and user interactions make those
  comparisons unreliable.
- Letting agents share a mutable workspace during a benchmark.
- Treating one aggregate score as the only result.
- Running destructive verification commands without explicit task
  configuration.
- Hiding failed or inconclusive runs behind a forced winner.
- Acting as a daily development gate, CI replacement, or automatic agent router.
- Re-running expensive comparisons every time a user asks a normal coding
  question.

## Core Principle

Agent comparison must be controlled:

```text
same task definition
+ same repo/context snapshot
+ same verification commands
+ isolated workspaces
+ Glasshouse capture
+ per-run session audit
+ evidence-backed comparison
```

If these conditions are not met, the comparison report should be marked
`inconclusive`.

## Product Entry Points

Recommended UI entry points should make the experimental nature clear:

- `AI Insight -> Compare Agents (Experimental)`
- `Labs -> Agent Compare`
- `Create Benchmark From This Session`
- `Run with Codex + Claude Code`

Creating a benchmark from an existing session should extract a task case, not
compare the existing session directly. The extracted task can reuse the user's
prompt and selected context files, but Codex and Claude Code must run in fresh
isolated environments.

## Personal Calibration UX

The UX should feel like a controlled experiment, not a normal chat action.

Recommended flow:

1. **Choose a calibration task**. The user can start from a current session,
   select a saved benchmark case, or write a fresh task prompt.
2. **Confirm the controlled inputs**. Glasshouse shows the repo revision,
   context files, applied local patch, verification commands, timeout, and
   estimated cost/time.
3. **Run the experiment**. Codex and Claude Code run in separate workspaces.
   The UI shows two lanes with phase, elapsed time, tool-call count, and live
   status.
4. **Verify both outputs**. Glasshouse runs the same verification commands and
   collects diffs, final answers, and session logs.
5. **Audit each run**. RFC 04 session-quality audit runs for each agent.
6. **Compare and learn**. The dashboard explains which agent performed better
   for this task and updates the user's agent-fit profile.

The setup screen should include a clear warning:

```text
This is an experimental comparison. It may take time, consume model quota, and
create temporary worktrees. Use it when you want to calibrate agent choice, not
for every normal task.
```

The result should prioritize practical guidance over a generic winner:

```text
For this repo and task type:
- Codex was stronger at verification discipline and preserving workspace state.
- Claude Code was faster at broad exploration but produced a larger diff.
- Recommendation: use Codex for bug fixes with strict tests; use Claude Code for
  exploratory repo mapping when speed matters.
```

Glasshouse should accumulate a small history of benchmark results and summarize
patterns across task types:

- Bug fixes
- New feature slices
- UI changes
- Documentation/RFC work
- Log/debugging investigations
- Research or current-information tasks

This history should be advisory. The user remains the decision-maker.

## Benchmark Task Case

A benchmark task should be explicit and reproducible:

```json
{
  "taskId": "fix-log-parser-regression",
  "prompt": "Fix the failing log parser test without changing source log files.",
  "repoRevision": "git-commit-sha",
  "workingDir": "/Users/yuan/ProjectRepo/glasshouse",
  "contextFiles": [
    "lib/log-stream.js",
    "test/log-stream.test.js",
    "docs/04-session-quality-audit.md"
  ],
  "verificationCommands": [
    "node --test test/log-stream.test.js",
    "npm run build"
  ],
  "successCriteria": [
    "tests pass",
    "no source log mutation",
    "no unrelated refactor"
  ],
  "limits": {
    "timeoutMs": 1800000,
    "maxReviewerCostUsd": null
  }
}
```

The task case should also store the benchmark prompt version and any user or
project instructions used to run the agents.

## Context Snapshot

The context snapshot should be a fixed input, not a live mutable state:

- Git commit SHA or explicit source archive hash.
- Selected context files and their content hashes.
- Relevant project instructions such as `AGENTS.md`.
- Environment summary, excluding secrets.
- Verification command list.
- Optional dependency lockfile hashes.

For coding tasks, the benchmark should run from a clean repo revision. If the
user wants to benchmark against uncommitted local changes, Glasshouse should
capture those changes as a patch and apply the same patch to both isolated
workspaces.

## Isolated Workspaces

Each agent run should use its own workspace:

```text
<LOG_DIR>/benchmarks/benchmark_<id>/worktrees/codex
<LOG_DIR>/benchmarks/benchmark_<id>/worktrees/claude
```

Implementation can use `git worktree`, temporary clones, or copied fixture
directories. The important invariant is that agents cannot see or modify each
other's work.

After each run, Glasshouse should collect:

- Final git diff.
- Modified file list.
- New/deleted files.
- Verification command outputs.
- Agent session log key.
- Runtime metadata such as duration and exit status.

## Agent Runners

The benchmark runtime should provide separate runners:

- `CodexRunner`
- `ClaudeCodeRunner`

Each runner is responsible for:

- Launching the corresponding CLI in the assigned isolated workspace.
- Injecting the same benchmark prompt.
- Passing the same allowed environment, with secrets excluded from captured
  evidence.
- Applying timeout and cancellation policy.
- Capturing stdout/stderr and process exit status.
- Registering the run with Glasshouse log capture.
- Tagging captured entries with benchmark metadata such as `benchmarkId`,
  `agentRunId`, `agentKind`, and `workspaceKind`.

Codex should use the Codex HTTP capture path when available. Claude Code should
use the existing Claude request log/proxy capture path. The comparison layer
should consume normalized run metadata, not provider-specific raw logs directly.

## Verification Runner

The verification runner executes the same commands after each agent finishes:

```json
{
  "agent": "codex",
  "verification": {
    "passed": true,
    "commands": [
      {
        "cmd": "npm run build",
        "exitCode": 0,
        "durationMs": 12400
      }
    ]
  }
}
```

Verification commands should run in the agent's isolated workspace after the
agent process exits or times out. Commands must be non-interactive and declared
in the benchmark task case.

If verification cannot run, the comparison should be marked `inconclusive`
unless the benchmark explicitly defines a valid fallback.

## Per-Run Session Audit

Each agent run should produce its own RFC 04 session-quality audit:

```text
codex agent run -> session audit A
claude agent run -> session audit B
```

The comparison report should reference those audit IDs instead of duplicating
all audit findings. Hard-gate failures from either audit should be lifted into
the comparison dashboard.

## Comparison Dimensions

Recommended dimensions:

- **Task completion**: whether the user goal was actually completed.
- **Verification result**: whether declared commands passed.
- **Code quality**: whether the diff is minimal, maintainable, and aligned with
  local architecture.
- **Tool use**: whether the agent used tools in the right order and handled
  failures correctly.
- **Context efficiency**: token usage, broad scans, repeated outputs, and
  context-window pressure.
- **Safety**: workspace hygiene, secrets, destructive commands, source-log
  mutation, and permission boundaries.
- **Communication**: progress updates, final answer clarity, and evidence in the
  final report.
- **Stability**: timeout, retries, incomplete turns, and recovery from tool
  failures.

Suggested default weighting for coding tasks:

```text
task completion      30%
verification result  25%
code quality         20%
tool use             10%
context efficiency   10%
communication         5%
```

Weights should be task-type configurable. For documentation-only tasks, code
quality may become artifact quality; for research tasks, source quality and
citation handling should matter more.

## Comparison Dashboard

The comparison dashboard route can be:

```text
/agent-compare/:benchmarkId
```

It should show:

- Overall result: `codex`, `claude`, `tie`, or `inconclusive`.
- Personal recommendation: which agent to use for this task type and why.
- Task case summary and source revision.
- Agent run status, duration, and exit status.
- Verification pass/fail per command.
- Diff summary: changed files, added/deleted lines, and patch links.
- Session audit summaries for both agents.
- Hard gates and high-severity findings.
- Tool-call counts and failed tool calls.
- Token and context-window metrics.
- Side-by-side final answers.
- Evidence links back to request logs, tool calls, diffs, and verification
  output.
- Historical pattern: how this result compares with previous benchmarks in the
  same task category.

The dashboard should explain why a winner was selected. If the evidence does not
support a confident choice, it should show `inconclusive`.

## Data Model

Suggested entities:

```ts
interface BenchmarkTask {
  benchmarkId: string;
  prompt: string;
  repoRevision: string;
  workingDir: string;
  contextFiles: string[];
  verificationCommands: string[];
  successCriteria: string[];
  taskType: "coding" | "review" | "docs" | "research" | "ui" | string;
  createdAt: string;
}

interface AgentRun {
  agentRunId: string;
  benchmarkId: string;
  agentKind: "codex" | "claude";
  workspacePath: string;
  status: "queued" | "running" | "verifying" | "complete" | "failed" | "timeout";
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  logSessionKey?: string;
  auditId?: string;
}

interface VerificationResult {
  agentRunId: string;
  passed: boolean;
  commands: Array<{
    cmd: string;
    exitCode: number | null;
    durationMs: number;
    stdoutExcerpt?: string;
    stderrExcerpt?: string;
  }>;
}

interface AgentComparisonReport {
  benchmarkId: string;
  status: "codex" | "claude" | "tie" | "inconclusive";
  scores: Record<string, { codex: number; claude: number }>;
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low" | "info";
    category: string;
    title: string;
    agentKind?: "codex" | "claude";
    evidenceRefs: string[];
  }>;
  recommendation: string;
}

interface AgentFitProfile {
  profileId: string;
  taskType: string;
  sampleSize: number;
  preferredAgent: "codex" | "claude" | "tie" | "inconclusive";
  confidence: "low" | "medium" | "high";
  rationale: string[];
  updatedAt: string;
}
```

## Storage

MVP can use a local JSON benchmark store:

```text
<LOG_DIR>/benchmarks/
  benchmark-index.json
  benchmark_<id>/
    task.json
    context-snapshot.json
    codex/
      run.json
      audit.json
      diff.patch
      verification.json
    claude/
      run.json
      audit.json
      diff.patch
      verification.json
    comparison.json
    fit-profile-update.json
```

Longer term, SQLite is better for filtering benchmark history, comparing many
runs, querying task types, and aggregating agent performance over time.

## Fairness and Safety Rules

- Do not compare runs from different repo revisions unless the dashboard marks
  the result as non-equivalent.
- Do not let one agent observe the other's diff, output, or audit during the
  run.
- Do not reuse a dirty workspace unless the same captured patch is applied to
  both runs.
- Do not auto-push, publish, delete user files, or modify source logs as part of
  a benchmark.
- Do not hide timeouts or verification failures.
- Do not send secrets from captured logs or local env into prompts, evidence
  bundles, or comparison reports.

## Implementation Slices

The following slices are future candidates only. They are not approved for
implementation yet.

- C0: this design document.
- C1: benchmark task case schema, context snapshot builder, and local JSON store.
- C2: isolated workspace creation with clean git worktrees or temp clones.
- C3: `CodexRunner` and `ClaudeCodeRunner` process orchestration with timeout,
  environment filtering, and Glasshouse metadata tagging.
- C4: verification runner and diff collector.
- C5: per-run RFC 04 session audit integration.
- C6: comparison scoring and report generation.
- C7: personal agent-fit profile aggregation by task type.
- C8: browser `Compare Agents` experimental flow and
  `/agent-compare/:benchmarkId` dashboard.
- C9: benchmark cleanup, retention, export, and documentation.

## Verification Plan

- Unit tests for benchmark task validation and context snapshot hashing.
- Unit tests for deduping and storing benchmark records.
- Integration tests with fake Codex and Claude commands that write known diffs.
- Verification-runner tests for pass, fail, timeout, and command-not-found
  cases.
- Diff collector tests for modified, added, deleted, and unchanged files.
- Audit integration tests using fixture session logs.
- Browser test for creating a benchmark and opening the comparison dashboard.
- Browser test for `inconclusive` display when verification cannot run.
- Browser test that the setup flow labels the operation as experimental and
  shows cost/time/worktree warnings.
- Unit test for updating an agent-fit profile from multiple benchmark reports.
- `npm test` and `npm run build` before shipping runtime changes.
