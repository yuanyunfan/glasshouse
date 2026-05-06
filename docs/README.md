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
  LLM review, then opens a quality dashboard. Status: design.

## Status Values

- `design` - design is being drafted.
- `design-complete` - design is ready for implementation.
- `in-progress` - implementation is underway.
- `done` - implementation and local verification are complete.
- `shipped` - released or deployed to users.
- `reference` - durable project reference, not a feature plan.
- `superseded` - replaced by a later document.
