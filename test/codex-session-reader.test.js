import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { listCodexSessions, readCodexSession, resolveCodexSessionPath } from '../lib/codex-session-reader.js';

const fixtureRoot = resolve('test/fixtures/codex-session');
const fixtureSessionId = '11111111-2222-3333-4444-555555555555';

function withCodexHome(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'ccv-codex-reader-'));
  cpSync(fixtureRoot, tmp, { recursive: true });
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('codex-session-reader', () => {
  it('lists sessions from CODEX_HOME style directory', () => withCodexHome((codexHome) => {
    const result = listCodexSessions({ codexHome });
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].id, fixtureSessionId);
    assert.equal(result.sessions[0].threadName, 'Codex fixture session');
    assert.equal(result.sessions[0].cwd, '/tmp/codex-fixture');
  }));

  it('resolves session IDs without accepting arbitrary paths', () => withCodexHome((codexHome) => {
    assert.equal(resolveCodexSessionPath('../bad', { codexHome }), null);
    const session = resolveCodexSessionPath(fixtureSessionId, { codexHome });
    assert.ok(session.path.endsWith('.jsonl'));
  }));

  it('reads and adapts a session while ignoring invalid trailing lines', () => withCodexHome((codexHome) => {
    const result = readCodexSession(fixtureSessionId, { codexHome });
    assert.equal(result.session.invalidLines, 1);
    assert.ok(result.entries.length >= 10);
    assert.equal(result.entries[0].provider, 'codex');
    assert.equal(result.entries.find(e => e.codexKind === 'Command').response.status, 200);
    assert.equal(result.entries.at(-1).response.body.usage.total_tokens, 1250);
  }));
});
