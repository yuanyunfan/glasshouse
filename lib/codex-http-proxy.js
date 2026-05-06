import http from 'node:http';
import https from 'node:https';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildCodexHttpEntry,
  parseSseEvents,
  responseFromSseEvents,
  sanitizeHeaders,
} from './codex-http-adapter.js';

const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function parseJsonBuffer(buffer) {
  if (!buffer || buffer.length === 0) return null;
  try { return JSON.parse(buffer.toString('utf-8')); } catch { return null; }
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_CAPTURE_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function normalizeResponseHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'content-encoding') continue;
    out[key] = value;
  }
  return out;
}

export function buildUpstreamUrl(upstreamBaseUrl, requestUrl) {
  const base = new URL(upstreamBaseUrl);
  const incoming = new URL(requestUrl || '/', 'http://127.0.0.1');
  const basePath = base.pathname.replace(/\/+$/, '');
  const reqPath = incoming.pathname.startsWith('/') ? incoming.pathname : `/${incoming.pathname}`;
  const path = basePath && (reqPath === basePath || reqPath.startsWith(`${basePath}/`))
    ? reqPath
    : `${basePath}${reqPath}`;
  base.pathname = path.replace(/\/{2,}/g, '/');
  base.search = incoming.search;
  return base;
}

function shouldCapturePath(pathname) {
  return pathname === '/v1/responses' || pathname === '/v1/chat/completions';
}

function writeEntry(entry, options = {}) {
  if (!entry) return;
  if (typeof options.onEntry === 'function') {
    options.onEntry(entry);
    return;
  }
  const logFile = options.logFile;
  if (!logFile) return;
  try { mkdirSync(dirname(logFile), { recursive: true }); } catch {}
  appendFileSync(logFile, `${JSON.stringify(entry)}\n---\n`);
}

function buildEntryFromExchange(exchange, options) {
  const contentType = String(exchange.responseHeaders?.['content-type'] || exchange.responseHeaders?.['Content-Type'] || '');
  const responseText = exchange.responseBody.toString('utf-8');
  let responseEvents = [];
  let responseBody = null;
  if (contentType.includes('text/event-stream')) {
    responseEvents = parseSseEvents(responseText);
    responseBody = responseFromSseEvents(responseEvents) || {};
  } else {
    responseBody = parseJsonBuffer(exchange.responseBody) || {};
  }
  return buildCodexHttpEntry({
    requestBody: parseJsonBuffer(exchange.requestBody) || {},
    requestHeaders: exchange.requestHeaders,
    responseHeaders: sanitizeHeaders(exchange.responseHeaders),
    responseBody,
    responseEvents,
    status: exchange.status,
    method: exchange.method,
    url: exchange.url,
    upstreamBaseUrl: options.upstreamBaseUrl,
    timestamp: exchange.timestamp,
  });
}

function proxyRequest(req, res, options) {
  return collectRequestBody(req).then(requestBody => new Promise((resolve) => {
    const upstreamUrl = buildUpstreamUrl(options.upstreamBaseUrl, req.url);
    const requestHeaders = { ...req.headers };
    delete requestHeaders.host;
    const transport = upstreamUrl.protocol === 'https:' ? https : http;
    const upstreamReq = transport.request(upstreamUrl, {
      method: req.method,
      headers: requestHeaders,
    }, (upstreamRes) => {
      const responseHeaders = normalizeResponseHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      const responseChunks = [];
      let capturedBytes = 0;
      upstreamRes.on('data', chunk => {
        if (capturedBytes + chunk.length <= MAX_CAPTURE_BYTES) {
          responseChunks.push(chunk);
          capturedBytes += chunk.length;
        }
        res.write(chunk);
      });
      upstreamRes.on('end', () => {
        res.end();
        if (shouldCapturePath(new URL(req.url, 'http://127.0.0.1').pathname)) {
          const entry = buildEntryFromExchange({
            requestBody,
            requestHeaders,
            responseHeaders: upstreamRes.headers,
            responseBody: Buffer.concat(responseChunks),
            status: upstreamRes.statusCode || 0,
            method: req.method,
            url: new URL(req.url, 'http://127.0.0.1').pathname,
            timestamp: new Date().toISOString(),
          }, options);
          writeEntry(entry, options);
        }
        resolve();
      });
      upstreamRes.on('error', () => {
        try { res.end(); } catch {}
        resolve();
      });
    });
    upstreamReq.on('error', err => {
      const body = JSON.stringify({ error: 'Codex HTTP proxy upstream error', message: err.message });
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(body);
      if (shouldCapturePath(new URL(req.url, 'http://127.0.0.1').pathname)) {
        const entry = buildCodexHttpEntry({
          requestBody: parseJsonBuffer(requestBody) || {},
          requestHeaders,
          responseHeaders: { 'content-type': 'application/json' },
          responseBody: { error: { message: err.message } },
          status: 502,
          method: req.method,
          url: new URL(req.url, 'http://127.0.0.1').pathname,
          upstreamBaseUrl: options.upstreamBaseUrl,
        });
        writeEntry(entry, options);
      }
      resolve();
    });
    if (requestBody.length > 0) upstreamReq.write(requestBody);
    upstreamReq.end();
  })).catch(err => {
    if (!res.headersSent) res.writeHead(err.message.includes('too large') ? 413 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
}

export function startCodexHttpProxy(options = {}) {
  if (!options.upstreamBaseUrl) throw new Error('upstreamBaseUrl is required');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (!shouldCapturePath(pathname)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unsupported Codex proxy path' }));
      return;
    }
    proxyRequest(req, res, options);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(options.port || 0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        upstreamBaseUrl: options.upstreamBaseUrl,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}
