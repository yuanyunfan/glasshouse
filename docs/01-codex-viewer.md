# 01 - Codex Viewer

## Status

Superseded by [02 - Codex HTTP Interceptor](./02-codex-http-interceptor.md).
The session JSONL reader described here has been removed from the runtime.

## Background

`cc-viewer` currently understands Claude Code request logs and local uploaded
JSONL logs. Codex CLI already writes session JSONL files under
`CODEX_HOME || ~/.codex`, but those files are not Claude API request logs and
cannot be loaded by the existing viewer without an adapter.

This change adds a read-only Codex provider that turns Codex session events into
viewer-compatible pseudo entries. It deliberately does not wrap Codex CLI and
does not intercept upstream OpenAI/Codex API traffic.

## Goals

1. List Codex sessions from `CODEX_HOME || ~/.codex`.
2. Load one Codex session as normalized pseudo entries that work in raw view,
   chat view, and token summaries.
3. Stream new Codex JSONL lines for the selected session over the existing SSE
   shape.
4. Keep Claude provider behavior unchanged unless the user explicitly selects
   Codex or opens a URL with `provider=codex`.

## Non-goals

- Launching, controlling, or wrapping Codex TUI.
- Intercepting Codex upstream API calls.
- Decrypting `encrypted_content` reasoning payloads.
- Accepting arbitrary file paths from browser requests.
- Replacing Claude log storage, local log import, or Electron terminal flows.

## Current Architecture

```text
Claude/ccv runtime
-> interceptor/log writer
-> server /events and /api/requests
-> React raw view / chat view / token stats
```

Codex writes independent session files:

```text
~/.codex/session_index.jsonl
~/.codex/history.jsonl
~/.codex/sessions/YYYY/MM/DD/*.jsonl
```

## Proposed Architecture

```text
Codex session JSONL
-> lib/codex-session-reader.js
-> lib/codex-entry-adapter.js
-> server /api/codex/sessions
-> server /events?provider=codex&session=<id>
-> React provider/session selector
-> existing raw/chat/token surfaces
```

## Data Lifecycle

Codex session files remain read-only. The reader scans trusted Codex roots,
parses JSONL line-by-line, ignores invalid incomplete lines, and resolves
session IDs to file paths by scanning `sessions/**/*.jsonl`. Browser requests
pass only `session=<id>`, never a path.

The adapter keeps an in-memory rolling message transcript for the selected
session and emits pseudo entries. Each pseudo entry preserves
`provider: "codex"` and `_codexRawEvents` so raw details remain available even
after normalization.

Codex session JSONL is not a one-to-one Claude API request log. Prompt and tool
metadata must be reconstructed from the events Codex does persist:

- `session_meta.payload.base_instructions.text` becomes the primary system
  prompt block.
- `response_item.message` events with `role: "developer"` or `role: "system"`
  are appended to the system prompt blocks.
- `response_item.message` events with `role: "user"` are stored as
  `body.contextMessages` for the Context tab. They are not inserted into
  `body.messages`, because some of these messages are hidden runtime context
  such as AGENTS/environment payloads and should not pollute the chat view.
- `response_item.tool_search_output.payload.tools` is flattened into
  Claude-like `body.tools[]` definitions with names, descriptions, and input
  schemas.

If Codex does not persist an upfront tool definition in the session JSONL, the
viewer can only show the tool call name plus the raw event. It must not invent
tool prompts that are not present in the source log.

Codex reasoning events that contain only `encrypted_content` are preserved in
the raw-event tab but are not rendered as `thinking` blocks. The viewer cannot
decrypt those payloads, and showing a fake placeholder in the conversation
misrepresents the context.

## Request Flow

```text
React header provider switch
-> GET /api/codex/sessions
-> user selects session id
-> EventSource /events?provider=codex&session=<id>
-> load_start / load_chunk / load_end
-> live tail entries as SSE data messages
```

## Resolution / Fallback Order

1. `CODEX_HOME` when set.
2. `~/.codex`.
3. `session_index.jsonl` for display names and updated time.
4. `history.jsonl` for last user prompt fallback.
5. File metadata and `session_meta` payload.

## Data Model / API Contract

```ts
interface CodexSessionSummary {
  id: string;
  path: string;
  filename: string;
  cwd: string;
  threadName: string;
  updatedAt: string;
  createdAt: string;
  size: number;
  eventCount: number;
}

interface CodexPseudoEntry {
  provider: "codex";
  codexKind: "User" | "Assistant" | "Tool" | "Command" | "Usage" | "Meta";
  timestamp: string;
  url: string;
  method: "CODEX";
  mainAgent: true;
  body: {
    model: string;
    system: Array<{ type: "text"; text: string }>;
    tools: Array<{ name: string; description?: string; input_schema?: unknown }>;
    messages: Array<{ role: "user" | "assistant"; content: unknown }>;
    contextMessages?: Array<{ role: "user" | "assistant"; content: unknown }>;
  };
  response: {
    status: 200;
    body: {
      model: string;
      content: unknown[];
      usage?: unknown;
    };
  };
  _codexRawEvents: unknown[];
}
```

## Naming And Boundary Decisions

### N1. Provider Switch

- Decision: keep Claude as the default provider.
- Reason: existing launch, logger, terminal, and local-log behavior must remain
  stable.
- Consequence: Codex paths run only when provider state or URL query requests
  Codex explicitly.

### N2. Session ID Instead Of Path

- Decision: Codex APIs accept `session=<id>` only.
- Reason: it avoids arbitrary filesystem reads from browser input.
- Consequence: server resolves IDs by scanning trusted Codex session roots.

### N3. Pseudo Entries

- Decision: normalize Codex events into Claude-like request entries.
- Reason: existing raw view, chat view, and token UI are already built around
  request entries.
- Consequence: the adapter must preserve `_codexRawEvents` to avoid losing raw
  source fidelity.

## Edge Cases

- Idempotency: repeated reads produce the same pseudo entry sequence for the
  same JSONL content.
- Concurrency: each Codex SSE client tails only the selected trusted file.
- Partial failure: invalid/incomplete lines are skipped and counted, not thrown
  through the API.
- Permissions/auth: no Codex credentials or upstream APIs are touched.
- Cache invalidation: live SSE tails new bytes from the selected file and keeps
  per-client adapter state.
- Timezone/date handling: session timestamps stay ISO/UTC; UI localizes.
- External API failure: not applicable because Codex files are local.
- Migration/rollback: revert Codex provider UI/API additions; Claude paths stay
  intact.

## Migration Strategy

1. Add docs and rules.
2. Add pure reader/adapter with fixtures and unit tests.
3. Add server endpoints and SSE load/tail path.
4. Add React provider/session controls and Codex raw details.
5. Keep Claude default behavior unchanged.
6. Document usage and verification.

Rollback:

- Revert C4/C3 to hide Codex UI/API.
- C1/C2 pure modules can remain unused without affecting Claude provider.

## Risks And Mitigations

| Risk | Mitigation |
|------|------------|
| Codex JSONL format drifts | Unknown events become Meta entries and keep raw JSON. |
| Long sessions are expensive to reload | Initial load streams chunks; live tail processes new bytes. |
| Browser can read arbitrary files | APIs accept session ID only and resolve under `CODEX_HOME/sessions`. |
| Duplicate agent messages | Adapter de-duplicates identical adjacent assistant text. |

## Testing Strategy

- L1: reader and adapter unit tests with Codex fixtures.
- L2: server endpoint tests for session listing, `provider=codex` requests, and
  invalid session IDs.
- L3: manual smoke in the browser after build if time allows.
- G1: `npm run build`.
- G2: no new dependencies; no secret-handling change.
- D1: tests use temp `CODEX_HOME` fixtures.

## Atomic Commit Plan

| # | Scope | Files | Touches behavior? | Verification |
|---|-------|-------|-------------------|--------------|
| C0 | Doc/RFC review | `AGENTS.md`, `docs/README.md`, this RFC | No | Doc review |
| C1 | Codex reader/adapter | `lib/codex-*.js` | No runtime cutover | L1 |
| C2 | Fixtures/tests | `test/fixtures/codex-session/*`, `test/codex-*.test.js` | No runtime cutover | L1 |
| C3 | Server API/SSE | `server.js`, server tests | Additive | L2 |
| C4 | UI provider/session surface | `src/*` | Additive | Build/manual smoke |
| C5 | Behavior switch | URL/default provider handling | Yes, isolated to explicit Codex selection | Regression |
| C6 | Docs/changelog | README files, `history.md` | User docs | Build/test record |

## Verification Record

| Slice | Command | Result | Notes |
|-------|---------|--------|-------|
| C0 | Doc review | Pass | Added `AGENTS.md`, docs index, and RFC before implementation. |
| C1/C2 | `node --test test/codex-session-reader.test.js test/codex-entry-adapter.test.js` | Pass | 5 tests passed. |
| C3 | `node --test test/server.test.js` | Pass | 40 tests passed, including Codex sessions/API/SSE load and live-tail coverage. |
| C4/C5/G1 | `npm run build` | Pass | Vite production build completed. |
| Regression | `npm test` | Pass | 1536 tests passed. |

Not run:

- L3 browser smoke.
- Reason: automated L1/L2/regression/build gates passed; no browser automation was requested in this turn.
- Residual risk: visual layout on very narrow headers should be checked manually if this ships immediately.

## Retrospective

### Symptom

No escaped production bug during this slice.

### Root Cause

Not applicable.

### Why Tests Missed It

Not applicable.

### Fix

Not applicable.

### Future Rule

Keep Codex file access session-ID based; do not add browser-provided file-path
inputs for Codex sessions.
