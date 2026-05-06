# 02 - Codex HTTP Interceptor

## Status

Done

## Background

The earlier Codex viewer read `CODEX_HOME || ~/.codex` session JSONL files.
Those logs were useful as a bootstrap path, but they were not complete upstream
HTTP request logs. They could omit full system/developer prompt material, tool
definitions, and the exact OpenAI Responses API request/response exchanged with
the configured provider. The runtime now uses the HTTP interceptor as the
default Codex provider path.

The first HTTP-interception slice adds a Codex-specific proxy between Codex CLI
and Raven:

```text
Codex CLI
-> Glasshouse Codex HTTP proxy: http://127.0.0.1:<port>/v1
-> Raven: http://localhost:7024/v1
-> upstream provider
```

Raven remains responsible for model routing, authentication, protocol handling,
and token/latency accounting. Glasshouse captures the OpenAI-compatible request
and response bodies for visualization only.

## Goals

1. Support `ccv run -- codex ...` without mutating `~/.codex/config.toml`.
   After `ccv -logger`, the shell hook also wraps direct `codex` agent
   invocations through the same path. Codex mode prints the Glasshouse URLs but
   does not open a browser unless `CCV_CODEX_OPEN_BROWSER=1` is set.
2. Read the active Codex provider config, defaulting to the `raven` provider
   when present.
3. Override only the spawned Codex process via
   `-c model_providers.<provider>.base_url=<local-proxy>/v1`.
4. Capture `/v1/responses` JSON and SSE responses, forward bytes unchanged to
   Codex, and write a viewer-compatible `provider: "codex"` entry tagged with
   `body.metadata.transport = "http-interceptor"`.
5. Remove the old `provider=codex` session JSONL reader after the HTTP path is
   proven.
6. Keep Claude proxy/interceptor behavior unchanged.

## Non-goals

- Changing Raven routes, Raven persistence, or Raven retention policy.
- Saving auth headers or environment secrets into Glasshouse logs.
- Decrypting Codex `encrypted_content`.
- Supporting arbitrary upstream paths beyond OpenAI-compatible `/v1/responses`
  and the reserved `/v1/chat/completions` path.

## Proposed Architecture

```text
cli.js
-> lib/codex-config.js
-> lib/codex-http-proxy.js
-> Raven upstream
-> lib/codex-http-adapter.js
-> existing Glasshouse JSONL log
-> server /events?provider=codex
-> React provider selector
```

The HTTP proxy is intentionally separate from `proxy.js` and `interceptor.js`.
Those modules are Anthropic/Claude-oriented and include Claude-specific request
classification, stream interpretation, and environment handling.

## Data Model

```js
{
  provider: "codex",
  url: "/v1/responses",
  method: "POST",
  timestamp,
  mainAgent: true,
  body: {
    model,
    system,
    tools,
    messages,
    contextMessages,
    metadata: {
      provider: "codex",
      transport: "http-interceptor",
      upstreamBaseUrl
    }
  },
  response: {
    status,
    headers,
    body
  },
  _codexRawRequest,
  _codexRawResponseEvents
}
```

Mapping rules:

- `request.instructions` becomes `body.system`.
- `request.tools` becomes Claude-like `body.tools`.
- `request.input` becomes `body.contextMessages`.
- Responses API output messages become assistant text blocks.
- Responses API function calls become assistant `tool_use` blocks.
- Usage maps to the existing token summary fields, preserving raw OpenAI usage
  under a `codex` metadata object.
- `encrypted_content` is preserved in raw response data only.

## Rollout Plan

- C0: RFC and user docs.
- C1: pure config parser and HTTP adapter with unit tests.
- C2: HTTP proxy with fake Raven integration tests.
- C3: CLI and server provider wiring.
- C4: React provider selector and i18n.
- C5: cut over `provider=codex` from the session reader to HTTP mode.
- N: remove the old session reader, session selector, fixtures, and tests.

## Verification

- Unit tests for Codex config parsing, header sanitization, and adapter mapping.
- Integration tests for JSON and SSE `/v1/responses` forwarding.
- Server tests for `provider=codex` request and SSE loading.
- CLI hook invariants for direct `codex` wrapping and Codex HTTP startup URLs.
- Regression tests for Claude proxy paths.
- `npm test`.
- `npm run build`.

Local verification recorded for this slice:

- `node --test test/codex-config.test.js test/codex-http-adapter.test.js test/codex-http-proxy.test.js test/server.test.js`
- `npm test`
- `npm run build`
