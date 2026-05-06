import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { request } from 'node:http';
import { startCodexHttpProxy, buildUpstreamUrl } from '../lib/codex-http-proxy.js';

function startFakeRaven(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

function postJson(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(raw),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      }));
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

describe('codex-http-proxy', () => {
  it('joins /v1 base URLs without duplicating the path', () => {
    assert.equal(
      buildUpstreamUrl('http://localhost:7024/v1', '/v1/responses').toString(),
      'http://localhost:7024/v1/responses'
    );
    assert.equal(
      buildUpstreamUrl('http://localhost:7024/v1', '/responses').toString(),
      'http://localhost:7024/v1/responses'
    );
  });

  it('forwards JSON /v1/responses and captures a sanitized entry', async () => {
    const entries = [];
    const upstream = await startFakeRaven((req, res) => {
      assert.equal(req.url, '/v1/responses');
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        assert.match(body, /Base prompt/);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'resp_json',
          model: 'gpt-5.4',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'JSON ok' }] }],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        }));
      });
    });
    const proxy = await startCodexHttpProxy({ upstreamBaseUrl: upstream.baseUrl, onEntry: entry => entries.push(entry) });
    try {
      const res = await postJson(proxy.port, '/v1/responses', {
        model: 'gpt-5.4',
        instructions: 'Base prompt',
        tools: [{ type: 'function', name: 'run', parameters: { type: 'object' } }],
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
      }, {
        authorization: 'Bearer secret',
        'x-api-key': 'secret',
      });

      assert.equal(res.status, 200);
      assert.match(res.body, /JSON ok/);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].provider, 'codex');
      assert.match(entries[0].body.system[0].text, /Base prompt/);
      assert.equal(entries[0].body.tools[0].name, 'run');
      assert.match(JSON.stringify(entries[0].body.contextMessages), /Hi/);
      assert.match(JSON.stringify(entries[0].response.body.content), /JSON ok/);
      assert.equal(entries[0]._codexRawRequest.headers.authorization, undefined);
      assert.equal(entries[0]._codexRawRequest.headers['x-api-key'], undefined);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it('forwards SSE bytes unchanged and captures completed response events', async () => {
    const entries = [];
    const sseBody = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"SSE "}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_sse","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"SSE ok"}]}],"usage":{"input_tokens":8,"output_tokens":2,"total_tokens":10}}}',
      '',
    ].join('\n');
    const upstream = await startFakeRaven((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseBody.slice(0, 80));
      setTimeout(() => res.end(sseBody.slice(80)), 10);
    });
    const proxy = await startCodexHttpProxy({ upstreamBaseUrl: upstream.baseUrl, onEntry: entry => entries.push(entry) });
    try {
      const res = await postJson(proxy.port, '/v1/responses', {
        model: 'gpt-5.4',
        input: 'Hello',
      });
      assert.equal(res.status, 200);
      assert.equal(res.body, sseBody);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]._codexRawResponseEvents.length, 2);
      assert.match(JSON.stringify(entries[0].response.body.content), /SSE ok/);
      assert.equal(entries[0].response.body.usage.total_tokens, 10);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});
