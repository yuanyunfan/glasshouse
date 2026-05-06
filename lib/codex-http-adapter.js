export const CODEX_PROVIDER = 'codex';

const SENSITIVE_HEADER_RE = /^(authorization|proxy-authorization|api-key|x-api-key|openai-api-key|anthropic-api-key|raven-api-key|cookie|set-cookie)$/i;
const SENSITIVE_HEADER_PART_RE = /(authorization|secret|token|api[-_]?key|cookie)/i;

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function textBlock(text) {
  return { type: 'text', text: String(text ?? '') };
}

function stringifyValue(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value ?? {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed); } catch { return value; }
}

function headerEntries(headers = {}) {
  if (typeof headers?.forEach === 'function') {
    const out = [];
    headers.forEach((value, key) => out.push([key, value]));
    return out;
  }
  if (Array.isArray(headers)) return headers;
  return Object.entries(headers || {});
}

export function sanitizeHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of headerEntries(headers)) {
    const name = String(key || '');
    if (!name) continue;
    if (SENSITIVE_HEADER_RE.test(name) || SENSITIVE_HEADER_PART_RE.test(name)) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function normalizeToolName(item, index = 0) {
  return item?.name || item?.function?.name || item?.tool_name || item?.type || `tool_${index}`;
}

function normalizeToolDefinition(tool, index) {
  if (!tool || typeof tool !== 'object') return null;
  const name = normalizeToolName(tool, index);
  if (!name) return null;
  const schema = tool.input_schema || tool.parameters || tool.function?.parameters || null;
  return {
    name,
    ...(tool.description || tool.function?.description ? { description: tool.description || tool.function.description } : {}),
    ...(schema ? { input_schema: cloneJson(schema) } : {}),
    codex: {
      type: tool.type || 'function',
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  };
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(normalizeToolDefinition).filter(Boolean);
}

function extractReasoningText(item) {
  if (typeof item?.text === 'string' && item.text.trim()) return item.text;
  if (typeof item?.content === 'string' && item.content.trim()) return item.content;
  if (Array.isArray(item?.summary)) {
    const text = item.summary.map(block => block?.text || block?.content || '').filter(Boolean).join('\n');
    if (text.trim()) return text;
  }
  return '';
}

function normalizeContentBlocks(content) {
  if (typeof content === 'string') return [textBlock(content)];
  if (!Array.isArray(content)) return [textBlock(stringifyValue(content))];
  const blocks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') {
      blocks.push(textBlock(block.text || block.content || ''));
    } else if (block.type === 'reasoning') {
      const thinking = extractReasoningText(block);
      if (thinking) blocks.push({ type: 'thinking', thinking });
    } else if (block.type === 'input_image' || block.type === 'image' || block.type === 'image_url') {
      blocks.push(textBlock(`[Image: ${block.image_url || block.url || block.path || 'embedded'}]`));
    } else {
      blocks.push(textBlock(stringifyValue(block)));
    }
  }
  return blocks;
}

function makeToolUseBlock(item, index) {
  return {
    type: 'tool_use',
    id: item.call_id || item.id || `codex-http-call-${index}`,
    name: normalizeToolName(item, index),
    input: parseMaybeJson(item.arguments ?? item.function?.arguments ?? item.input ?? {}),
  };
}

function makeToolResultBlock(item, index) {
  return {
    type: 'tool_result',
    tool_use_id: item.call_id || item.id || `codex-http-call-${index}`,
    content: stringifyValue(item.output ?? item.result ?? item.content ?? item),
    is_error: item.status === 'failed' || item.is_error === true,
  };
}

const RESPONSES_BUILTIN_CALL_TYPES = new Set([
  'web_search_call',
  'file_search_call',
  'computer_call',
  'code_interpreter_call',
  'image_generation_call',
  'local_shell_call',
  'mcp_call',
]);

function isResponsesBuiltinCall(item) {
  return RESPONSES_BUILTIN_CALL_TYPES.has(item?.type);
}

function normalizeBuiltinToolName(item) {
  if (item?.type === 'web_search_call') {
    return item?.action?.type === 'open_page' ? 'web_open_page' : 'web_search';
  }
  return String(item?.type || 'responses_builtin_call').replace(/_call$/, '');
}

function makeBuiltinToolUseBlock(item, index) {
  const input = {};
  if (item?.status) input.status = item.status;
  if (item?.action) input.action = cloneJson(item.action);
  for (const key of ['query', 'queries', 'url', 'arguments', 'input', 'output']) {
    if (item?.[key] !== undefined) input[key] = cloneJson(item[key]);
  }
  return {
    type: 'tool_use',
    id: item.call_id || item.id || `codex-http-${item.type || 'builtin'}-${index}`,
    name: normalizeBuiltinToolName(item),
    input,
  };
}

function addMessage(messages, role, content) {
  const blocks = Array.isArray(content) ? content.filter(Boolean) : normalizeContentBlocks(content);
  if (blocks.length === 0) return;
  messages.push({ role, content: cloneJson(blocks) });
}

function normalizeInputMessages(requestBody = {}) {
  const messages = [];
  const input = requestBody.input ?? requestBody.messages ?? [];
  if (typeof input === 'string') {
    addMessage(messages, 'user', [textBlock(input)]);
    return messages;
  }
  if (!Array.isArray(input)) {
    if (input != null) addMessage(messages, 'user', normalizeContentBlocks(input));
    return messages;
  }

  input.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      addMessage(messages, 'user', normalizeContentBlocks(item));
      return;
    }
    const role = item.role || (item.type === 'function_call' ? 'assistant' : 'user');
    if (item.type === 'message' || item.role) {
      if (role === 'system' || role === 'developer') return;
      addMessage(messages, role === 'assistant' ? 'assistant' : 'user', normalizeContentBlocks(item.content ?? item.text ?? item));
    } else if (item.type === 'function_call') {
      addMessage(messages, 'assistant', [makeToolUseBlock(item, index)]);
    } else if (item.type === 'function_call_output') {
      addMessage(messages, 'user', [makeToolResultBlock(item, index)]);
    } else if (isResponsesBuiltinCall(item)) {
      addMessage(messages, 'assistant', [makeBuiltinToolUseBlock(item, index)]);
    } else if (item.type === 'reasoning') {
      const thinking = extractReasoningText(item);
      if (thinking) addMessage(messages, 'assistant', [{ type: 'thinking', thinking }]);
    } else if (item.type === 'input_text' || item.type === 'text') {
      addMessage(messages, 'user', [textBlock(item.text || item.content || '')]);
    } else {
      addMessage(messages, 'user', normalizeContentBlocks(item.content ?? item));
    }
  });
  return messages;
}

function extractSystemBlocks(requestBody = {}) {
  const blocks = [];
  if (requestBody.instructions) blocks.push(textBlock(requestBody.instructions));
  const input = requestBody.input ?? requestBody.messages ?? [];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      if (item.role === 'system' || item.role === 'developer') {
        const text = normalizeContentBlocks(item.content ?? item.text ?? item)
          .map(block => block.text || block.thinking || '')
          .filter(Boolean)
          .join('\n');
        if (text.trim()) blocks.push(textBlock(text));
      }
    }
  }
  return blocks.length > 0 ? blocks : [textBlock('Codex Responses API request captured by cc-viewer.')];
}

function assistantBlocksFromChoices(responseBody = {}) {
  const choice = Array.isArray(responseBody.choices) ? responseBody.choices[0] : null;
  const msg = choice?.message;
  if (!msg) return [];
  const blocks = normalizeContentBlocks(msg.content || '');
  if (Array.isArray(msg.tool_calls)) {
    msg.tool_calls.forEach((call, index) => {
      blocks.push(makeToolUseBlock({
        id: call.id,
        type: call.type || 'function_call',
        name: call.function?.name || call.name,
        arguments: call.function?.arguments || call.arguments,
      }, index));
    });
  }
  return blocks.filter(block => block.type !== 'text' || block.text !== '');
}

function assistantBlocksFromResponsesOutput(responseBody = {}) {
  const blocks = [];
  const output = Array.isArray(responseBody.output) ? responseBody.output : [];
  output.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'message') {
      if (!item.role || item.role === 'assistant') {
        blocks.push(...normalizeContentBlocks(item.content ?? item.text ?? ''));
      }
    } else if (item.type === 'function_call') {
      blocks.push(makeToolUseBlock(item, index));
    } else if (item.type === 'function_call_output') {
      blocks.push(makeToolResultBlock(item, index));
    } else if (isResponsesBuiltinCall(item)) {
      blocks.push(makeBuiltinToolUseBlock(item, index));
    } else if (item.type === 'output_text' || item.type === 'text') {
      blocks.push(textBlock(item.text || item.content || ''));
    } else if (item.type === 'reasoning') {
      const thinking = extractReasoningText(item);
      if (thinking) blocks.push({ type: 'thinking', thinking });
    }
  });
  if (blocks.length === 0 && typeof responseBody.output_text === 'string') {
    blocks.push(textBlock(responseBody.output_text));
  }
  return blocks.filter(block => block.type !== 'text' || block.text !== '');
}

function normalizeUsage(usage = null) {
  if (!usage || typeof usage !== 'object') return undefined;
  const inputTotal = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const cached = usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? 0;
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const reasoning = usage.output_tokens_details?.reasoning_tokens
    ?? usage.completion_tokens_details?.reasoning_tokens
    ?? 0;
  return {
    input_tokens: Math.max(0, inputTotal - cached),
    output_tokens: output,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: reasoning,
    total_tokens: usage.total_tokens ?? inputTotal + output,
    codex: cloneJson(usage),
  };
}

export function parseSseEvents(text) {
  const events = [];
  let eventName = 'message';
  let dataLines = [];
  let id = '';

  const flush = () => {
    if (dataLines.length === 0 && !id) {
      eventName = 'message';
      return;
    }
    const data = dataLines.join('\n');
    let parsed = null;
    if (data && data !== '[DONE]') {
      try { parsed = JSON.parse(data); } catch {}
    }
    events.push({ event: eventName, data, ...(id ? { id } : {}), ...(parsed ? { parsed } : {}) });
    eventName = 'message';
    dataLines = [];
    id = '';
  };

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (rawLine === '') {
      flush();
      continue;
    }
    if (rawLine.startsWith(':')) continue;
    const idx = rawLine.indexOf(':');
    const field = idx === -1 ? rawLine : rawLine.slice(0, idx);
    const value = idx === -1 ? '' : rawLine.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') eventName = value || 'message';
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
  }
  flush();
  return events;
}

export function responseFromSseEvents(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const parsed = events[i]?.parsed;
    if (parsed?.response) return parsed.response;
    if (parsed?.type === 'response.completed' && parsed.response) return parsed.response;
    if (parsed?.object === 'response') return parsed;
  }
  let text = '';
  for (const event of events) {
    const parsed = event?.parsed;
    if (!parsed) continue;
    if (typeof parsed.delta === 'string' && /output_text\.delta$/.test(parsed.type || event.event || '')) {
      text += parsed.delta;
    } else if (typeof parsed.text === 'string' && /output_text\.delta$/.test(parsed.type || event.event || '')) {
      text += parsed.text;
    }
  }
  if (text) {
    return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
  }
  return null;
}

export function buildCodexHttpEntry(options = {}) {
  const requestBody = options.requestBody && typeof options.requestBody === 'object' ? options.requestBody : {};
  const responseBody = options.responseBody && typeof options.responseBody === 'object' ? options.responseBody : {};
  const timestamp = options.timestamp || new Date().toISOString();
  const contextMessages = normalizeInputMessages(requestBody);
  const assistantBlocks = [
    ...assistantBlocksFromResponsesOutput(responseBody),
    ...(responseBody.output ? [] : assistantBlocksFromChoices(responseBody)),
  ];
  const messages = contextMessages.map(cloneJson);
  if (assistantBlocks.length > 0) messages.push({ role: 'assistant', content: cloneJson(assistantBlocks) });
  const usage = normalizeUsage(responseBody.usage);

  return {
    provider: CODEX_PROVIDER,
    timestamp,
    url: options.url || '/v1/responses',
    method: options.method || 'POST',
    mainAgent: true,
    body: {
      model: requestBody.model || responseBody.model || 'codex',
      system: extractSystemBlocks(requestBody),
      tools: normalizeTools(requestBody.tools),
      messages,
      contextMessages,
      metadata: {
        provider: 'codex',
        transport: 'http-interceptor',
        upstreamBaseUrl: options.upstreamBaseUrl || '',
      },
    },
    response: {
      status: options.status || 0,
      headers: sanitizeHeaders(options.responseHeaders || {}),
      body: {
        model: responseBody.model || requestBody.model || 'codex',
        content: cloneJson(assistantBlocks),
        ...(usage ? { usage } : {}),
        ...(responseBody.output ? { output: cloneJson(responseBody.output) } : {}),
        ...(responseBody.id ? { id: responseBody.id } : {}),
        ...(responseBody.error ? { error: cloneJson(responseBody.error) } : {}),
      },
    },
    _codexRawRequest: {
      headers: sanitizeHeaders(options.requestHeaders || {}),
      body: cloneJson(requestBody),
    },
    _codexRawResponseEvents: cloneJson(options.responseEvents || []),
  };
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
