import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (ch === '#' && !quote) return line.slice(0, i);
  }
  return line;
}

function splitTomlPath(pathText) {
  const parts = [];
  let cur = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < pathText.length; i++) {
    const ch = pathText[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      escaped = true;
      cur += ch;
      continue;
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (ch === '.' && !quote) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function splitTomlAssignment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (ch === '=' && !quote) return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  }
  return null;
}

function parseTomlValue(raw) {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function getOrCreateTable(root, pathParts) {
  let cur = root;
  for (const part of pathParts) {
    if (!cur[part] || typeof cur[part] !== 'object' || Array.isArray(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  return cur;
}

export function parseCodexConfigToml(text) {
  const root = {};
  let table = root;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      table = getOrCreateTable(root, splitTomlPath(header[1]));
      continue;
    }
    const assignment = splitTomlAssignment(line);
    if (!assignment) continue;
    const [key, rawValue] = assignment;
    const keyParts = splitTomlPath(key);
    if (keyParts.length === 0) continue;
    const target = keyParts.length === 1 ? table : getOrCreateTable(table, keyParts.slice(0, -1));
    target[keyParts[keyParts.length - 1]] = parseTomlValue(rawValue);
  }
  return root;
}

export function getCodexConfigPath(options = {}) {
  const codexHome = resolve(options.codexHome || options.env?.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex'));
  return options.configPath || join(codexHome, 'config.toml');
}

export function readCodexProviderConfig(options = {}) {
  const configPath = getCodexConfigPath(options);
  const text = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const config = parseCodexConfigToml(text);
  const providers = config.model_providers && typeof config.model_providers === 'object'
    ? config.model_providers
    : {};
  const provider = config.model_provider
    || (providers.raven ? 'raven' : Object.keys(providers)[0])
    || 'raven';
  const providerConfig = providers[provider] && typeof providers[provider] === 'object'
    ? providers[provider]
    : {};
  const baseUrl = providerConfig.base_url || providerConfig.baseURL || (provider === 'raven' ? 'http://localhost:7024/v1' : '');
  const wireApi = providerConfig.wire_api || config.wire_api || 'responses';
  return {
    configPath,
    provider,
    baseUrl,
    wireApi,
    providerConfig,
    config,
  };
}
