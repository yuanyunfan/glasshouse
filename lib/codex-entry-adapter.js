export const CODEX_PROVIDER = 'codex';

export const CODEX_KINDS = Object.freeze({
  USER: 'User',
  ASSISTANT: 'Assistant',
  TOOL: 'Tool',
  COMMAND: 'Command',
  USAGE: 'Usage',
  META: 'Meta',
});

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function snapshotSessionMeta(meta = {}) {
  return {
    id: meta.id || '',
    cwd: meta.cwd || '',
    filename: meta.filename || '',
    threadName: meta.threadName || '',
    updatedAt: meta.updatedAt || '',
    createdAt: meta.createdAt || meta.timestamp || '',
    cliVersion: meta.cliVersion || meta.cli_version || '',
    source: meta.source || '',
    originator: meta.originator || '',
    modelProvider: meta.modelProvider || meta.model_provider || '',
  };
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value ?? {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed); } catch { return value; }
}

function stringifyValue(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function textBlock(text) {
  return { type: 'text', text: String(text ?? '') };
}

function extractTextFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map(block => block?.text || block?.content || '')
    .filter(Boolean)
    .join('\n');
}

function convertCodexMessageContent(content, role) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifyValue(content);
  const blocks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'output_text' || block.type === 'input_text' || block.type === 'text') {
      blocks.push(textBlock(block.text || block.content || ''));
    } else if (block.type === 'reasoning') {
      blocks.push({ type: 'thinking', thinking: block.text || block.content || '' });
    } else if (block.type === 'image' || block.type === 'input_image') {
      blocks.push(textBlock(`[Image: ${block.path || block.image_url || block.url || 'embedded'}]`));
    } else if (block.type === 'tool_use' || block.type === 'tool_result') {
      blocks.push(cloneJson(block));
    } else {
      blocks.push(textBlock(stringifyValue(block)));
    }
  }
  if (role === 'assistant') return blocks;
  return blocks.length === 1 ? blocks[0].text : blocks;
}

function getTokenUsage(payload) {
  const info = payload?.info;
  if (!info) return null;
  const usage = info.total_token_usage || info.last_token_usage || null;
  if (!usage) return null;
  const cached = usage.cached_input_tokens || 0;
  const input = usage.input_tokens || 0;
  return {
    input_tokens: Math.max(0, input - cached),
    output_tokens: usage.output_tokens || 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: usage.reasoning_output_tokens || 0,
    total_tokens: usage.total_tokens || input + (usage.output_tokens || 0),
    codex: {
      input_tokens: usage.input_tokens || 0,
      cached_input_tokens: cached,
      output_tokens: usage.output_tokens || 0,
      reasoning_output_tokens: usage.reasoning_output_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      model_context_window: info.model_context_window || 0,
    },
  };
}

function getReasoningText(payload) {
  if (typeof payload?.content === 'string' && payload.content.trim()) return payload.content;
  const summaryText = extractTextFromBlocks(payload?.summary);
  if (summaryText.trim()) return summaryText;
  if (payload?.encrypted_content) return '[Encrypted reasoning content]';
  return '';
}

function formatExecOutput(payload) {
  const command = Array.isArray(payload?.command) ? payload.command.join(' ') : '';
  const cwd = payload?.cwd ? `cwd: ${payload.cwd}` : '';
  const status = payload?.status || (payload?.exit_code === 0 ? 'completed' : 'failed');
  const exit = payload?.exit_code != null ? `exit_code: ${payload.exit_code}` : '';
  const output = payload?.aggregated_output || payload?.formatted_output || payload?.stdout || payload?.stderr || '';
  return [command, cwd, status, exit, output].filter(Boolean).join('\n');
}

function normalizeToolName(payload) {
  if (payload?.namespace && payload?.name) return `${payload.namespace}.${payload.name}`;
  if (payload?.name) return payload.name;
  if (payload?.action?.type) return payload.action.type;
  return payload?.type || 'tool';
}

function makeToolInput(payload) {
  if (payload?.arguments !== undefined) return parseMaybeJson(payload.arguments);
  if (payload?.action !== undefined) return cloneJson(payload.action);
  if (payload?.query !== undefined) return { query: payload.query };
  return {};
}

function makeToolResultText(payload) {
  if (payload?.output !== undefined) return stringifyValue(payload.output);
  if (payload?.aggregated_output !== undefined || payload?.stdout !== undefined || payload?.stderr !== undefined) {
    return formatExecOutput(payload);
  }
  if (payload?.result !== undefined) return stringifyValue(payload.result);
  if (payload?.tools !== undefined) return stringifyValue(payload.tools);
  if (payload?.action !== undefined) return stringifyValue(payload.action);
  return stringifyValue(payload);
}

function entryUrl(sessionId, index, kind) {
  return `codex://session/${encodeURIComponent(sessionId || 'unknown')}/${index}/${kind.toLowerCase()}`;
}

function safeIsoTimestamp(value) {
  if (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) return value;
  return new Date().toISOString();
}

export function createCodexEntryAdapter(options = {}) {
  const session = options.session || {};
  const state = {
    sessionId: session.id || '',
    model: session.model || session.modelProvider || session.model_provider || 'codex',
    cwd: session.cwd || '',
    messages: [],
    tools: new Map(),
    latestUsage: null,
    eventIndex: 0,
    lastAssistantText: null,
    meta: cloneJson(session),
  };

  function pushUser(text, timestamp) {
    const blocks = [textBlock(text)];
    const imageTexts = [];
    const raw = arguments[2] || {};
    for (const img of raw.images || []) imageTexts.push(`[Image: ${img}]`);
    for (const img of raw.local_images || []) imageTexts.push(`[Image: ${img}]`);
    if (imageTexts.length > 0) blocks.push(textBlock(imageTexts.join('\n')));
    state.messages.push({ role: 'user', content: blocks, _timestamp: timestamp });
  }

  function pushAssistant(blocks, timestamp) {
    const normalized = Array.isArray(blocks) ? blocks.filter(Boolean) : [textBlock(blocks)];
    const textOnly = normalized.length === 1 && normalized[0]?.type === 'text' ? normalized[0].text : null;
    if (textOnly && state.lastAssistantText === textOnly) return false;
    state.messages.push({ role: 'assistant', content: normalized, _timestamp: timestamp });
    state.lastAssistantText = textOnly;
    return true;
  }

  function pushToolUse(payload, timestamp) {
    const id = payload.call_id || payload.id || `codex-call-${state.eventIndex}`;
    const name = normalizeToolName(payload);
    state.tools.set(name, { name });
    state.messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: makeToolInput(payload) }],
      _timestamp: timestamp,
    });
    state.lastAssistantText = null;
    return id;
  }

  function pushToolResult(payload, timestamp) {
    const id = payload.call_id || payload.id || `codex-call-${state.eventIndex}`;
    state.messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: makeToolResultText(payload), is_error: payload.status === 'failed' || payload.exit_code > 0 }],
      _timestamp: timestamp,
    });
    state.lastAssistantText = null;
    return id;
  }

  function makeEntry(rawEvent, kind, responseContent = []) {
    const timestamp = safeIsoTimestamp(rawEvent?.timestamp);
    const index = state.eventIndex++;
    const messageCount = state.messages.length;
    const body = {
      model: state.model,
      system: [{ type: 'text', text: 'Codex session JSONL normalized by cc-viewer.' }],
      tools: Array.from(state.tools.values()),
      // Keep a per-entry array snapshot without deep-copying every prior message.
      // Deep cloning cumulative history for each Codex event makes long sessions O(n^2)
      // in retained strings and can OOM before the normal client-side slimmer runs.
      messages: state.messages.slice(),
      metadata: {
        provider: CODEX_PROVIDER,
        session_id: state.sessionId,
        cwd: state.cwd,
      },
    };
    return {
      provider: CODEX_PROVIDER,
      codexKind: kind,
      timestamp,
      url: entryUrl(state.sessionId, index, kind),
      method: 'CODEX',
      mainAgent: true,
      status: 200,
      headers: {},
      body,
      response: {
        status: 200,
        headers: {},
        body: {
          id: `${state.sessionId || 'codex'}-${index}`,
          type: 'codex_event',
          model: state.model,
          content: cloneJson(responseContent),
          usage: state.latestUsage ? cloneJson(state.latestUsage) : undefined,
        },
      },
      _codexRawEvents: [cloneJson(rawEvent)],
      _codexSession: snapshotSessionMeta(state.meta),
      _messageCount: messageCount,
    };
  }

  function ingest(rawEvent) {
    if (!rawEvent || typeof rawEvent !== 'object') return null;
    const payload = rawEvent.payload || {};
    const timestamp = safeIsoTimestamp(rawEvent.timestamp);

    if (rawEvent.type === 'session_meta') {
      Object.assign(state.meta, payload);
      state.sessionId = payload.id || state.sessionId;
      state.cwd = payload.cwd || state.cwd;
      state.model = payload.model || payload.model_provider || state.model;
      return makeEntry(rawEvent, CODEX_KINDS.META, [textBlock('Session metadata')]);
    }

    if (rawEvent.type === 'turn_context') {
      return makeEntry(rawEvent, CODEX_KINDS.META, [textBlock('Turn context')]);
    }

    if (rawEvent.type === 'event_msg') {
      switch (payload.type) {
        case 'user_message':
          pushUser(payload.message || '', timestamp, payload);
          return makeEntry(rawEvent, CODEX_KINDS.USER, [textBlock(payload.message || '')]);
        case 'agent_message':
          pushAssistant([textBlock(payload.message || '')], timestamp);
          return makeEntry(rawEvent, CODEX_KINDS.ASSISTANT, [textBlock(payload.message || '')]);
        case 'exec_command_end':
          pushToolResult(payload, timestamp);
          return makeEntry(rawEvent, CODEX_KINDS.COMMAND, [textBlock(formatExecOutput(payload))]);
        case 'token_count':
          state.latestUsage = getTokenUsage(payload) || state.latestUsage;
          return makeEntry(rawEvent, CODEX_KINDS.USAGE, []);
        case 'task_started':
        case 'task_complete':
          return makeEntry(rawEvent, CODEX_KINDS.META, [textBlock(payload.type)]);
        default:
          if (payload.call_id && /_end$/.test(payload.type || '')) {
            pushToolResult(payload, timestamp);
            return makeEntry(rawEvent, CODEX_KINDS.TOOL, [textBlock(makeToolResultText(payload))]);
          }
          return makeEntry(rawEvent, CODEX_KINDS.META, [textBlock(payload.type || rawEvent.type)]);
      }
    }

    if (rawEvent.type === 'response_item') {
      switch (payload.type) {
        case 'message': {
          if (payload.role === 'assistant') {
            const content = convertCodexMessageContent(payload.content, 'assistant');
            pushAssistant(content, timestamp);
            return makeEntry(rawEvent, CODEX_KINDS.ASSISTANT, content);
          }
          return makeEntry(rawEvent, CODEX_KINDS.META, [textBlock(`message:${payload.role || 'unknown'}`)]);
        }
        case 'reasoning': {
          const thinking = getReasoningText(payload);
          if (thinking) {
            const block = { type: 'thinking', thinking };
            pushAssistant([block], timestamp);
            return makeEntry(rawEvent, CODEX_KINDS.ASSISTANT, [block]);
          }
          return makeEntry(rawEvent, CODEX_KINDS.META, [textBlock('reasoning')]);
        }
        case 'function_call':
        case 'web_search_call':
        case 'tool_search_call':
          pushToolUse(payload, timestamp);
          return makeEntry(rawEvent, CODEX_KINDS.TOOL, [{ type: 'tool_use', id: payload.call_id || payload.id || '', name: normalizeToolName(payload), input: makeToolInput(payload) }]);
        case 'function_call_output':
        case 'tool_search_output':
          pushToolResult(payload, timestamp);
          return makeEntry(rawEvent, CODEX_KINDS.TOOL, [textBlock(makeToolResultText(payload))]);
        default:
          if (/_call$/.test(payload.type || '') || payload.call_id) {
            pushToolUse(payload, timestamp);
            return makeEntry(rawEvent, CODEX_KINDS.TOOL, []);
          }
          return makeEntry(rawEvent, CODEX_KINDS.META, [textBlock(payload.type || rawEvent.type)]);
      }
    }

    return makeEntry(rawEvent, CODEX_KINDS.META, [textBlock(rawEvent.type || 'unknown')]);
  }

  return { ingest, state };
}

export function adaptCodexEvents(rawEvents, options = {}) {
  const adapter = createCodexEntryAdapter(options);
  const entries = [];
  for (const event of rawEvents || []) {
    const entry = adapter.ingest(event);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function slimCodexEntries(entries) {
  if (!Array.isArray(entries) || entries.length <= 1) return entries;

  let fullEntryIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (Array.isArray(entries[i]?.body?.messages)) {
      fullEntryIndex = i;
      break;
    }
  }
  if (fullEntryIndex < 0) return entries;

  for (let i = 0; i < fullEntryIndex; i++) {
    const entry = entries[i];
    const messages = entry?.body?.messages;
    if (!entry?.mainAgent || !Array.isArray(messages) || messages.length === 0) continue;
    entry._messageCount = entry._messageCount || messages.length;
    entry._slimmed = true;
    entry._fullEntryIndex = fullEntryIndex;
    entry.body = { ...entry.body, messages: [] };
  }

  return entries;
}

export function buildCodexContextWindow(usage) {
  const codexUsage = usage?.codex || usage;
  const contextSize = codexUsage?.model_context_window || 0;
  const input = codexUsage?.input_tokens || 0;
  const output = codexUsage?.output_tokens || 0;
  const total = input + output;
  if (!contextSize || total <= 0) return null;
  const used = Math.min(100, Math.max(0, Math.round((total / contextSize) * 100)));
  return {
    total_input_tokens: input,
    total_output_tokens: output,
    total_tokens: total,
    context_window_size: contextSize,
    used_percentage: used,
    remaining_percentage: Math.max(0, 100 - used),
  };
}
