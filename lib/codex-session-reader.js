import { existsSync, statSync, readdirSync, readFileSync, realpathSync, openSync, readSync, closeSync, watchFile, unwatchFile } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { adaptCodexEvents, createCodexEntryAdapter, slimCodexEntries } from './codex-entry-adapter.js';
import { isPathContained } from './file-api.js';

const READ_CHUNK_SIZE = 256 * 1024;

export function getCodexHome(env = process.env) {
  return resolve(env.CODEX_HOME || join(homedir(), '.codex'));
}

function safeReadJsonLines(filePath) {
  const result = { records: [], invalidLines: 0 };
  if (!existsSync(filePath)) return result;
  const lines = readFileSync(filePath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try { result.records.push(JSON.parse(line)); } catch { result.invalidLines++; }
  }
  return result;
}

function walkJsonl(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonl(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

function readFirstEvent(filePath) {
  if (!existsSync(filePath)) return null;
  const fd = openSync(filePath, 'r');
  const buf = Buffer.alloc(READ_CHUNK_SIZE);
  try {
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    if (!bytes) return null;
    const firstLine = buf.toString('utf-8', 0, bytes).split(/\r?\n/, 1)[0];
    if (!firstLine.trim()) return null;
    try { return JSON.parse(firstLine); } catch { return null; }
  } finally {
    closeSync(fd);
  }
}

function idFromFilename(filePath) {
  const m = basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : basename(filePath, '.jsonl');
}

export function readCodexSessionIndex(codexHome = getCodexHome()) {
  const map = new Map();
  const { records } = safeReadJsonLines(join(codexHome, 'session_index.jsonl'));
  for (const record of records) {
    if (record?.id) map.set(record.id, record);
  }
  return map;
}

export function readCodexHistory(codexHome = getCodexHome()) {
  const map = new Map();
  const { records } = safeReadJsonLines(join(codexHome, 'history.jsonl'));
  for (const record of records) {
    if (!record?.session_id) continue;
    map.set(record.session_id, record);
  }
  return map;
}

export function parseCodexSessionFile(filePath) {
  const result = safeReadJsonLines(filePath);
  let meta = null;
  for (const record of result.records) {
    if (record?.type === 'session_meta') {
      meta = record.payload || {};
      break;
    }
  }
  return { events: result.records, invalidLines: result.invalidLines, meta };
}

export function listCodexSessions(options = {}) {
  const codexHome = resolve(options.codexHome || getCodexHome());
  const sessionsRoot = join(codexHome, 'sessions');
  const sessionIndex = readCodexSessionIndex(codexHome);
  const history = readCodexHistory(codexHome);
  const files = walkJsonl(sessionsRoot);
  const sessions = [];

  for (const filePath of files) {
    let realPath;
    try {
      realPath = realpathSync(filePath);
      if (!isPathContained(realPath, sessionsRoot)) continue;
    } catch {
      continue;
    }

    const first = readFirstEvent(realPath);
    const meta = first?.type === 'session_meta' ? first.payload || {} : {};
    let stat;
    try { stat = statSync(realPath); } catch { continue; }
    const id = meta.id || idFromFilename(realPath);
    const idx = sessionIndex.get(id) || {};
    const hist = history.get(id) || {};
    const updatedAt = idx.updated_at || stat.mtime.toISOString();
    sessions.push({
      id,
      path: realPath,
      filename: basename(realPath),
      cwd: meta.cwd || '',
      threadName: idx.thread_name || hist.text || '',
      updatedAt,
      createdAt: meta.timestamp || idx.created_at || '',
      size: stat.size,
      eventCount: null,
      cliVersion: meta.cli_version || '',
      source: meta.source || '',
      originator: meta.originator || '',
      modelProvider: meta.model_provider || '',
    });
  }

  sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { codexHome, sessionsRoot, sessions };
}

export function resolveCodexSessionPath(sessionId, options = {}) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const { sessions, sessionsRoot } = listCodexSessions(options);
  const found = sessions.find(s => s.id === sessionId);
  if (!found) return null;
  try {
    const realPath = realpathSync(found.path);
    if (!isPathContained(realPath, sessionsRoot)) return null;
    return { ...found, path: realPath, sessionsRoot };
  } catch {
    return null;
  }
}

export function readCodexSession(sessionId, options = {}) {
  const session = resolveCodexSessionPath(sessionId, options);
  if (!session) {
    const err = new Error('Codex session not found');
    err.code = 'CODEX_SESSION_NOT_FOUND';
    throw err;
  }
  const parsed = parseCodexSessionFile(session.path);
  const mergedSession = { ...session, ...(parsed.meta || {}) };
  const entries = adaptCodexEvents(parsed.events, { session: mergedSession });
  if (options.slim) slimCodexEntries(entries);
  return {
    session: { ...mergedSession, eventCount: parsed.events.length, invalidLines: parsed.invalidLines },
    entries,
    invalidLines: parsed.invalidLines,
  };
}

export function createCodexSessionTail(sessionId, onEntry, options = {}) {
  const session = resolveCodexSessionPath(sessionId, options);
  if (!session) {
    const err = new Error('Codex session not found');
    err.code = 'CODEX_SESSION_NOT_FOUND';
    throw err;
  }

  const parsed = parseCodexSessionFile(session.path);
  const adapter = createCodexEntryAdapter({ session: { ...session, ...(parsed.meta || {}) } });
  for (const event of parsed.events) adapter.ingest(event);

  let offset = existsSync(session.path) ? statSync(session.path).size : 0;
  let pending = '';

  const consumeLine = (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch {
      pending = line;
      return;
    }
    const entry = adapter.ingest(event);
    if (entry) onEntry(entry);
  };

  const watcher = () => {
    let currentSize;
    try { currentSize = statSync(session.path).size; } catch { return; }
    if (currentSize < offset) {
      offset = currentSize;
      pending = '';
      return;
    }
    if (currentSize <= offset) return;
    const bytesToRead = currentSize - offset;
    const buf = Buffer.alloc(bytesToRead);
    const fd = openSync(session.path, 'r');
    try {
      readSync(fd, buf, 0, bytesToRead, offset);
    } finally {
      closeSync(fd);
    }
    offset = currentSize;
    const chunk = pending + buf.toString('utf-8');
    const lines = chunk.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) consumeLine(line);
    if (pending.trim()) {
      try {
        JSON.parse(pending);
        consumeLine(pending);
        pending = '';
      } catch {}
    }
  };

  watchFile(session.path, { interval: options.interval || 500 }, watcher);
  return () => unwatchFile(session.path, watcher);
}
