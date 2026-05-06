import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_DIR } from '../findcc.js';
import { buildAuditBundle, createAuditFromEntries, getAudit, runRuleChecks } from '../lib/session-audit.js';

process.env.CCV_WORKSPACE_MODE = '1';
process.env.CCV_CLI_MODE = '0';

function entry(index, overrides = {}) {
  return {
    timestamp: `2026-05-06T10:0${index}:00.000Z`,
    url: '/v1/messages',
    method: 'POST',
    mainAgent: true,
    body: {
      system: [{ type: 'text', text: 'Follow project rules.' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: overrides.user || 'Fix the failing test.' }] },
        ...(overrides.messages || []),
      ],
    },
    response: {
      status: 200,
      body: {
        content: overrides.responseContent || [{ type: 'text', text: overrides.answer || 'Done.' }],
        usage: overrides.usage || { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      },
    },
  };
}

function httpRequest(port, path, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          json() { return JSON.parse(data); },
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

describe('session audit core', () => {
  it('builds a compact bundle and flags failed tools followed by success claims', () => {
    const entries = [
      entry(1, {
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { cmd: 'npm test' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Process exited with code 1', is_error: true }] },
        ],
        answer: 'Done, tests passed.',
      }),
    ];
    const bundle = buildAuditBundle(entries, {
      sourceProvider: 'claude',
      sourceSessionKey: 'test-session',
      sourceLabel: 'test session',
    });
    const findings = runRuleChecks(bundle);
    assert.equal(bundle.entries.length, 1);
    assert.equal(bundle.metrics.failedToolResultCount, 1);
    assert.ok(findings.some(item => item.id === 'rule.failed-tool-results'));
    assert.ok(findings.some(item => item.id === 'rule.failed-tool-then-success-claim' && item.hardGate));
  });

  it('persists audits, reuses matching dedupe keys, and keeps forced reruns', () => {
    const tmpLogDir = join(LOG_DIR, `audit-core-${Date.now()}`);
    mkdirSync(tmpLogDir, { recursive: true });
    try {
      const entries = [entry(1, { answer: 'Implemented and verified.' })];
      const first = createAuditFromEntries({
        logDir: tmpLogDir,
        sourceProvider: 'claude',
        sourceSessionKey: 'local-log:proj/a.jsonl',
        sourceLabel: 'proj/a.jsonl',
        entries,
      });
      const second = createAuditFromEntries({
        logDir: tmpLogDir,
        sourceProvider: 'claude',
        sourceSessionKey: 'local-log:proj/a.jsonl',
        sourceLabel: 'proj/a.jsonl',
        entries,
      });
      const forced = createAuditFromEntries({
        logDir: tmpLogDir,
        sourceProvider: 'claude',
        sourceSessionKey: 'local-log:proj/a.jsonl',
        sourceLabel: 'proj/a.jsonl',
        entries,
        force: true,
      });
      assert.equal(second.auditId, first.auditId);
      assert.equal(second.reused, true);
      assert.notEqual(forced.auditId, first.auditId);
      assert.equal(forced.audit.metadata.attempt, 2);
      assert.equal(getAudit(tmpLogDir, first.auditId).metadata.auditId, first.auditId);
    } finally {
      rmSync(tmpLogDir, { recursive: true, force: true });
    }
  });
});

describe('session audit API', { concurrency: false }, () => {
  let startViewer, stopViewer, getPort;
  let port;
  const projectName = `auditApi_${Date.now()}`;
  const fileName = `${projectName}_20260506_100000.jsonl`;
  const fileRel = `${projectName}/${fileName}`;
  const projectDir = join(LOG_DIR, projectName);

  before(async () => {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, fileName), `${JSON.stringify(entry(1, { answer: 'Implemented.' }))}\n---\n`);
    const mod = await import('../server.js');
    startViewer = mod.startViewer;
    stopViewer = mod.stopViewer;
    getPort = mod.getPort;
    const srv = await startViewer();
    assert.ok(srv);
    port = getPort();
  });

  after(() => {
    stopViewer();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(join(LOG_DIR, 'audits'), { recursive: true, force: true });
  });

  it('rejects unsafe local log paths', async () => {
    const res = await httpRequest(port, '/api/session-audits', {
      method: 'POST',
      body: { source: { type: 'local-log', file: '../../etc/passwd' } },
    });
    assert.equal(res.status, 400);
  });

  it('creates, reads, reuses, reruns, and refreshes local-log audits', async () => {
    const create = await httpRequest(port, '/api/session-audits', {
      method: 'POST',
      body: { provider: 'claude', source: { type: 'local-log', file: fileRel } },
    });
    assert.equal(create.status, 200);
    const first = create.json();
    assert.ok(first.auditId);
    assert.equal(first.reused, false);

    const read = await httpRequest(port, `/api/session-audits/${encodeURIComponent(first.auditId)}`);
    assert.equal(read.status, 200);
    assert.equal(read.json().report.metrics.entryCount, 1);

    const reused = await httpRequest(port, '/api/session-audits', {
      method: 'POST',
      body: { provider: 'claude', source: { type: 'local-log', file: fileRel } },
    });
    assert.equal(reused.status, 200);
    assert.equal(reused.json().auditId, first.auditId);
    assert.equal(reused.json().reused, true);

    const forced = await httpRequest(port, '/api/session-audits', {
      method: 'POST',
      body: { provider: 'claude', source: { type: 'local-log', file: fileRel }, force: true },
    });
    assert.equal(forced.status, 200);
    assert.notEqual(forced.json().auditId, first.auditId);

    appendFileSync(join(projectDir, fileName), `${JSON.stringify(entry(2, { answer: 'Still done.' }))}\n---\n`);
    const changed = await httpRequest(port, '/api/session-audits', {
      method: 'POST',
      body: { provider: 'claude', source: { type: 'local-log', file: fileRel } },
    });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.json().auditId, first.auditId);
  });
});
