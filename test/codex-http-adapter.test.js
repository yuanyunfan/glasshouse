import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexHttpEntry,
  parseSseEvents,
  responseFromSseEvents,
  sanitizeHeaders,
} from '../lib/codex-http-adapter.js';

describe('codex-http-adapter', () => {
  it('maps Responses request and response into a viewer entry', () => {
    const entry = buildCodexHttpEntry({
      url: '/v1/responses',
      status: 200,
      upstreamBaseUrl: 'http://localhost:7024/v1',
      requestHeaders: {
        authorization: 'Bearer secret',
        'api-key': 'secret',
        'content-type': 'application/json',
      },
      responseHeaders: { 'content-type': 'application/json' },
      requestBody: {
        model: 'gpt-5.4',
        instructions: 'Base system prompt',
        tools: [{
          type: 'function',
          name: 'exec_command',
          description: 'Run a command.',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        }],
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
          { type: 'reasoning', encrypted_content: 'request-ciphertext' },
          {
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', query: 'SPY 1 month performance', queries: ['SPY 1 month performance'] },
          },
          { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
        ],
      },
      responseBody: {
        id: 'resp_1',
        model: 'gpt-5.4',
        output: [
          { type: 'reasoning', encrypted_content: 'ciphertext' },
          {
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'open_page', url: 'https://example.com/market' },
          },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
          { type: 'function_call', call_id: 'call_2', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 12,
          total_tokens: 112,
          input_tokens_details: { cached_tokens: 25 },
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    });

    assert.equal(entry.provider, 'codex');
    assert.equal(entry.body.metadata.provider, 'codex');
    assert.equal(entry.body.metadata.transport, 'http-interceptor');
    assert.match(entry.body.system[0].text, /Base system prompt/);
    assert.equal(entry.body.tools[0].name, 'exec_command');
    assert.equal(entry.body.tools[0].input_schema.properties.cmd.type, 'string');
    assert.match(JSON.stringify(entry.body.contextMessages), /Hello/);
    assert.match(JSON.stringify(entry.body.contextMessages), /ok/);
    assert.match(JSON.stringify(entry.body.contextMessages), /web_search/);
    assert.match(JSON.stringify(entry.body.messages), /Done/);
    assert.match(JSON.stringify(entry.body.messages), /tool_use/);
    assert.match(JSON.stringify(entry.body.messages), /web_open_page/);
    assert.match(JSON.stringify(entry.body.messages), /https:\/\/example.com\/market/);
    assert.doesNotMatch(JSON.stringify(entry.body.messages), /ciphertext/);
    assert.doesNotMatch(JSON.stringify(entry.body.contextMessages), /request-ciphertext/);
    assert.equal(entry.response.body.usage.input_tokens, 75);
    assert.equal(entry.response.body.usage.cache_read_input_tokens, 25);
    assert.equal(entry.response.body.usage.reasoning_output_tokens, 4);
    assert.equal(entry._codexRawRequest.headers.authorization, undefined);
    assert.equal(entry._codexRawRequest.headers['api-key'], undefined);
    assert.equal(entry._codexRawRequest.headers['content-type'], 'application/json');
  });

  it('sanitizes secret-like headers', () => {
    const headers = sanitizeHeaders({
      Authorization: 'Bearer a',
      'x-api-key': 'b',
      RAVEN_API_KEY: 'c',
      'x-custom-token': 'd',
      accept: 'application/json',
    });
    assert.deepEqual(headers, { accept: 'application/json' });
  });

  it('parses Responses SSE events and extracts completed response', () => {
    const events = parseSseEvents([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"Hel"}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"lo"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}]}}',
      '',
    ].join('\n'));

    assert.equal(events.length, 3);
    assert.equal(events[0].event, 'response.output_text.delta');
    const response = responseFromSseEvents(events);
    assert.equal(response.model, 'gpt-5.4');
    assert.equal(response.output[0].content[0].text, 'Hello');
  });
});
