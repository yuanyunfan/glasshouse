# RFC Index

This directory tracks numbered feature RFCs and verification records for
substantial changes.

## Active RFCs

- [01 - Codex Viewer](./01-codex-viewer.md) - Historical offline/live viewer for
  Codex session JSONL files. Status: superseded by 02.
- [02 - Codex HTTP Interceptor](./02-codex-http-interceptor.md) - Capture Codex
  OpenAI Responses API traffic through a local Raven-facing proxy. Status:
  done.
- [03 - Glasshouse Rename](./03-glasshouse-rename.md) - Rename public branding
  and publishing metadata from CC Viewer / cc-viewer to Glasshouse while keeping
  compatibility interfaces stable. Status: done.
- [04 - Session Quality Audit](./04-session-quality-audit.md) - Define the
  browser `AI Insight` flow that runs deterministic checks plus a fresh Codex
  LLM review, then opens a quality dashboard. Status: in-progress.
- [05 - Agent Compare Benchmark](./05-agent-compare-benchmark.md) - Define an
  experimental Codex vs Claude Code calibration mode with isolated workspaces,
  shared verification, per-run audits, and a personal agent-fit profile. Status:
  idea/exploration.

## Status Values

- `design` - design is being drafted.
- `idea/exploration` - early concept captured for future evaluation; do not
  implement yet.
- `design-complete` - design is ready for implementation.
- `in-progress` - implementation is underway.
- `done` - implementation and local verification are complete.
- `shipped` - released or deployed to users.
- `reference` - durable project reference, not a feature plan.
- `superseded` - replaced by a later document.
