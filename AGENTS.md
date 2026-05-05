# Project

`cc-viewer` is a Node.js + React viewer for Claude Code request logs. It also
exposes local server APIs, SSE streams, and Electron/native runtime surfaces.

## Architecture

- `server.js` - HTTP/SSE API server and local runtime endpoints.
- `lib/` - server-side helpers for log streaming, parsing, plugins, proxying,
  file access, and runtime state.
- `src/` - React frontend, shared UI state, i18n, and viewer components.
- `electron/` - Electron shell and tab/workspace integration.
- `test/` - Node test runner coverage for server, parser, and helper behavior.
- `docs/` - numbered RFCs plus localized user docs.

## Invariants

- Do not use CSS `!important`.
- Add i18n entries for new interactive controls. Use `src/i18n.js` for React UI
  and `i18n.js` for server/CLI text.
- Keep raw external logs read-only. Viewer features must not mutate Claude or
  Codex source logs.
- Keep provider boundaries isolated. Claude log interception, Codex session
  reading, and local uploaded log handling must not share unsafe file-path
  inputs.
- Resolve file access from trusted roots. Do not accept arbitrary session/log
  paths from the browser.
- Store and compare timestamps as UTC/ISO strings; localize only at display
  boundaries.
- Do not do unrelated refactors while implementing feature slices.
- Do not auto-commit, push, or publish. Ask the user first.
- Do not increment the package version except as part of an explicit publish
  flow.

## Quality System

- L1: unit/component tests for pure parser, adapter, helper, and view-model
  behavior.
- L2: integration/API tests for HTTP endpoints and SSE/load flows.
- L3: browser/system E2E for user-visible flows when UI behavior changes need
  visual verification.
- G1: `npm run build` after code changes; run lint/type gates if the repo adds
  them.
- G2: dependency/secret checks when dependencies, auth, or packaging changes.
- D1: test-resource isolation for filesystem fixtures, temp dirs, external
  processes, and production resources.

## Development Protocol

1. For complex changes, write or update `docs/NN-feature.md` before coding.
2. Update `docs/README.md` with the RFC number, link, description, and status.
3. Split implementation into C-slices:
   - C0: docs/design only
   - C1: pure core logic and L1 tests
   - C2: fixtures/storage/baseline prep
   - C3: service/API/runtime surface
   - C4: UI/CLI/admin surface
   - C5: behavior switch/cutover
   - C6: operational docs/hooks
   - N: cleanup/removal
4. Implement one slice at a time and record verification in the RFC.
5. Keep cutover and cleanup isolated.
6. Run the smallest proving gate first, then broaden to `npm test` and
   `npm run build` before declaring code changes complete.
7. Every escaped bug or failed assumption should produce a future-facing rule,
   test, gate, or RFC update.

## Repo-Specific Checks

- For new server-side `.js` files in the repo root or `lib/`, add corresponding
  unit tests under `test/`.
- Update `history.md` for user-visible changes.
- Update `README.md` and localized README files when user-facing usage changes.
- Before publishing to npm, check whether new root-level `.js` files need to be
  included in `package.json#files`.
