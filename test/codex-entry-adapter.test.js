import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adaptCodexEvents, buildCodexContextWindow, CODEX_KINDS } from '../lib/codex-entry-adapter.js';

describe('codex-entry-adapter', () => {
  it('normalizes Codex events into viewer pseudo entries', () => {
    const events = [
      { timestamp: '2026-05-05T10:00:00.000Z', type: 'session_meta', payload: { id: 's1', cwd: '/repo', model_provider: 'gpt-5.4' } },
      { timestamp: '2026-05-05T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Hello' } },
      { timestamp: '2026-05-05T10:00:02.000Z', type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'abc', summary: [] } },
      { timestamp: '2026-05-05T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pwd"}', call_id: 'call_1' } },
      { timestamp: '2026-05-05T10:00:04.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: '/repo' } },
      { timestamp: '2026-05-05T10:00:05.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } },
      { timestamp: '2026-05-05T10:00:06.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
      { timestamp: '2026-05-05T10:00:07.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 1020 }, model_context_window: 2000 } } },
    ];

    const entries = adaptCodexEvents(events, { session: { id: 's1', cwd: '/repo' } });
    assert.equal(entries.length, events.length);
    assert.equal(entries[1].provider, 'codex');
    assert.equal(entries[1].codexKind, CODEX_KINDS.USER);
    assert.equal(entries[3].codexKind, CODEX_KINDS.TOOL);
    assert.equal(entries[4].body.messages.at(-1).content[0].type, 'tool_result');
    assert.equal(entries[7].codexKind, CODEX_KINDS.USAGE);
    assert.equal(entries[7].response.body.usage.input_tokens, 600);
    assert.equal(entries[7].response.body.usage.cache_read_input_tokens, 400);
    assert.equal(entries[7]._codexRawEvents[0].payload.type, 'token_count');

    const finalMessages = entries.at(-1).body.messages;
    const assistantTexts = finalMessages
      .filter(m => m.role === 'assistant')
      .flatMap(m => Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }])
      .filter(b => b.type === 'text')
      .map(b => b.text);
    assert.deepEqual(assistantTexts, ['Done.'], 'agent_message and response_item.message should dedupe adjacent identical text');

    const thinking = finalMessages.find(m => Array.isArray(m.content) && m.content.some(b => b.type === 'thinking'));
    assert.ok(thinking, 'reasoning should become a thinking block');
  });

  it('builds context window data from Codex usage', () => {
    const context = buildCodexContextWindow({
      codex: {
        input_tokens: 100,
        output_tokens: 50,
        model_context_window: 1000,
      },
    });
    assert.equal(context.used_percentage, 15);
    assert.equal(context.remaining_percentage, 85);
  });
});
