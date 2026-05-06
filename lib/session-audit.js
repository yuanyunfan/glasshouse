import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AUDIT_STORE_VERSION = 1;
export const RULE_ENGINE_VERSION = 'session-audit-rules-v1';
export const REVIEWER_PROMPT_VERSION = 'session-audit-reviewer-v1';
export const REDACTION_POLICY_VERSION = 'session-audit-redaction-v1';
export const REPORT_SCHEMA_VERSION = 'session-audit-report-v1';

const MAX_EXCERPT_CHARS = 480;
const MAX_TEXTS_PER_ENTRY = 6;
const MAX_SYSTEM_EXCERPTS = 8;
const SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*\s*[:=]\s*["']?[A-Za-z0-9._~:/+=-]{8,})\b/i;
const VERIFY_RE = /\b(npm\s+(?:run\s+)?(?:test|build|lint)|node\s+--test|pytest|pnpm\s+(?:test|build|lint)|yarn\s+(?:test|build|lint)|vitest|playwright|tsc\b|eslint\b|cargo\s+test|go\s+test)\b/i;
const DESTRUCTIVE_RE = /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+checkout\s+--|git\s+clean\s+-fd|sudo\s+rm|mkfs|dd\s+if=)\b/i;
const COMPLETION_CLAIM_RE = /\b(done|completed|implemented|fixed|resolved|tests?\s+passed|build\s+passed|successfully|verified|验证通过|完成|已实现|已修复|测试通过|构建通过)\b/i;
const FAILURE_RE = /\b(Process exited with code [1-9]|exit code [1-9]|failed|failure|error|exception|traceback|AssertionError|SyntaxError|TypeError|ReferenceError|npm ERR!|ERR!)\b/i;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashValue(value, prefix = '') {
  const hash = createHash('sha256').update(stableStringify(value)).digest('hex');
  return prefix ? `${prefix}_${hash}` : hash;
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function safeText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function compactWhitespace(text) {
  return safeText(text).replace(/\s+/g, ' ').trim();
}

function excerpt(text, maxChars = MAX_EXCERPT_CHARS) {
  const compact = compactWhitespace(text);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}…`;
}

function redact(text) {
  return safeText(text).replace(SECRET_RE, '[REDACTED]');
}

function blockText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (typeof block.thinking === 'string') return block.thinking;
  if (Array.isArray(block.content)) return block.content.map(blockText).filter(Boolean).join('\n');
  if (Array.isArray(block.summary)) return block.summary.map(blockText).filter(Boolean).join('\n');
  return '';
}

function contentBlocks(content) {
  if (content == null) return [];
  if (Array.isArray(content)) return content;
  return [{ type: 'text', text: safeText(content) }];
}

function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  return contentBlocks(message.content).map(blockText).filter(Boolean).join('\n');
}

function collectMessages(entry) {
  const messages = [];
  if (Array.isArray(entry?.body?.messages)) messages.push(...entry.body.messages);
  if (Array.isArray(entry?.body?.contextMessages)) {
    for (const message of entry.body.contextMessages) {
      if (!messages.includes(message)) messages.push(message);
    }
  }
  return messages;
}

function collectContentBlocks(entry) {
  const blocks = [];
  for (const message of collectMessages(entry)) {
    for (const block of contentBlocks(message?.content)) {
      blocks.push({ block, role: message?.role || 'unknown', source: 'message' });
    }
  }
  for (const block of contentBlocks(entry?.response?.body?.content)) {
    blocks.push({ block, role: 'assistant', source: 'response' });
  }
  return blocks;
}

function toolInputSummary(input) {
  if (input == null) return '';
  return excerpt(redact(typeof input === 'string' ? input : stableStringify(input)), 260);
}

function extractToolResultText(block) {
  if (!block || typeof block !== 'object') return '';
  const content = block.content ?? block.result ?? block.output ?? '';
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join('\n');
  return safeText(content);
}

function inferToolResultStatus(block, text) {
  if (block?.is_error === true || block?.status === 'failed') return 'error';
  if (FAILURE_RE.test(text || '')) return 'error';
  if (block?.is_error === false || block?.status === 'success' || block?.status === 'completed') return 'ok';
  return 'unknown';
}

function normalizedUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0) || 0;
  const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0) || 0;
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens + cacheRead + cacheCreate) || 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreate,
    totalTokens,
  };
}

function summarizeEntry(entry, index) {
  const messages = collectMessages(entry);
  const userMessages = messages
    .filter(message => message?.role === 'user')
    .map(messageText)
    .map(text => excerpt(redact(text)))
    .filter(Boolean)
    .slice(-MAX_TEXTS_PER_ENTRY);
  const assistantText = [];
  const toolCalls = [];
  const toolById = new Map();

  for (const { block, role, source } of collectContentBlocks(entry)) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use') {
      const tool = {
        id: block.id || `${index}:${toolCalls.length}`,
        name: block.name || 'tool',
        inputSummary: toolInputSummary(block.input),
        status: 'unknown',
        source,
      };
      toolCalls.push(tool);
      toolById.set(tool.id, tool);
    } else if (block.type === 'tool_result') {
      const text = extractToolResultText(block);
      const status = inferToolResultStatus(block, text);
      const toolUseId = block.tool_use_id || block.id || '';
      const existing = toolById.get(toolUseId);
      const resultSummary = excerpt(redact(text), 360);
      if (existing) {
        existing.resultSummary = resultSummary;
        existing.status = status;
      } else {
        toolCalls.push({
          id: toolUseId || `${index}:result:${toolCalls.length}`,
          name: 'tool_result',
          inputSummary: '',
          resultSummary,
          status,
          source,
        });
      }
    } else if (role === 'assistant') {
      const text = blockText(block);
      if (text) assistantText.push(excerpt(redact(text)));
    }
  }

  const usage = normalizedUsage(entry?.response?.body?.usage);
  const responseStatus = Number(entry?.response?.status ?? entry?.status ?? 0) || undefined;
  return {
    requestIndex: index,
    timestamp: entry?.timestamp || null,
    roleSummary: entry?.mainAgent === false ? 'non-main-agent' : 'main-agent',
    responseStatus,
    userMessages,
    assistantText: assistantText.slice(-MAX_TEXTS_PER_ENTRY),
    toolCalls,
    usage,
  };
}

function sourceInstructions(entries) {
  const out = [];
  for (const entry of entries || []) {
    const system = entry?.body?.system;
    for (const block of contentBlocks(system)) {
      const text = blockText(block);
      if (!text) continue;
      out.push(excerpt(redact(text), 520));
      if (out.length >= MAX_SYSTEM_EXCERPTS) return out;
    }
  }
  return out;
}

function latestUserGoal(bundleEntries) {
  for (let i = bundleEntries.length - 1; i >= 0; i--) {
    const userMessages = bundleEntries[i]?.userMessages || [];
    if (userMessages.length > 0) return userMessages[userMessages.length - 1];
  }
  return '';
}

function computeMetrics(entries) {
  let toolCallCount = 0;
  let failedToolResultCount = 0;
  let totalTokens = 0;
  let maxRequestTokens = 0;
  const toolCounts = {};
  for (const entry of entries) {
    for (const tool of entry.toolCalls || []) {
      if (tool.name !== 'tool_result') {
        toolCallCount++;
        toolCounts[tool.name] = (toolCounts[tool.name] || 0) + 1;
      }
      if (tool.status === 'error') failedToolResultCount++;
    }
    const tokens = Number(entry.usage?.totalTokens || 0);
    totalTokens += tokens;
    if (tokens > maxRequestTokens) maxRequestTokens = tokens;
  }
  return {
    entryCount: entries.length,
    toolCallCount,
    failedToolResultCount,
    totalTokens,
    maxRequestTokens,
    firstTimestamp: entries[0]?.timestamp || null,
    lastTimestamp: entries[entries.length - 1]?.timestamp || null,
    toolCounts,
  };
}

export function getAuditConfigHash(options = {}) {
  return hashValue({
    ruleEngineVersion: RULE_ENGINE_VERSION,
    reviewerPromptVersion: REVIEWER_PROMPT_VERSION,
    reviewerModel: options.reviewerModel || 'not_configured',
    redactionPolicyVersion: REDACTION_POLICY_VERSION,
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
  }, 'cfg').slice(0, 68);
}

export function computeSourceRevision({ sourceProvider, sourceSessionKey, entries = [], sourceSize = null }) {
  const lastEntry = entries[entries.length - 1] || null;
  return hashValue({
    sourceProvider,
    sourceSessionKey,
    entryCount: entries.length,
    lastEntryTimestamp: lastEntry?.timestamp || null,
    sourceSize,
    lastEntryDedupKey: lastEntry ? `${lastEntry.timestamp || ''}|${lastEntry.url || ''}|${lastEntry.method || ''}` : '',
  }, 'rev').slice(0, 68);
}

export function buildAuditBundle(entries = [], source = {}) {
  const bundleEntries = (Array.isArray(entries) ? entries : []).map(summarizeEntry);
  const metrics = computeMetrics(bundleEntries);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    sessionId: source.sourceSessionKey || source.sessionId || 'current-session',
    provider: source.sourceProvider || source.provider || 'unknown',
    sourceLabel: source.sourceLabel || source.label || source.sourceSessionKey || 'Current session',
    userGoal: latestUserGoal(bundleEntries),
    projectInstructions: sourceInstructions(entries),
    entries: bundleEntries,
    metrics,
  };
}

function finding(id, severity, category, title, evidence, recommendation, hardGate = false) {
  return {
    id,
    severity,
    category,
    title,
    evidence: Array.isArray(evidence) ? evidence : [],
    ...(recommendation ? { recommendation } : {}),
    hardGate,
  };
}

function evidenceForTool(entry, tool, path = 'toolCalls') {
  return {
    requestIndex: entry.requestIndex,
    path,
    toolUseId: tool?.id,
    excerpt: tool?.resultSummary || tool?.inputSummary || tool?.name || '',
  };
}

function latestAssistantText(bundle) {
  for (let i = bundle.entries.length - 1; i >= 0; i--) {
    const texts = bundle.entries[i]?.assistantText || [];
    if (texts.length > 0) return { entry: bundle.entries[i], text: texts.join('\n') };
  }
  return { entry: null, text: '' };
}

export function runRuleChecks(bundle) {
  const findings = [];
  if (!bundle || !Array.isArray(bundle.entries) || bundle.entries.length === 0) {
    findings.push(finding(
      'rule.empty-session',
      'info',
      'evidence',
      'No auditable requests were found in this session.',
      [],
      'Open or capture a session with at least one request before running AI Insight.'
    ));
    return findings;
  }

  const failedTools = [];
  const destructiveTools = [];
  const secretEvidence = [];
  let verificationEvidence = false;
  let broadOutputEvidence = null;
  let highTokenEvidence = null;

  for (const entry of bundle.entries) {
    const textCorpus = [
      ...(entry.userMessages || []),
      ...(entry.assistantText || []),
      ...(entry.toolCalls || []).flatMap(tool => [tool.inputSummary, tool.resultSummary]),
    ].filter(Boolean).join('\n');

    if (SECRET_RE.test(textCorpus)) {
      secretEvidence.push({ requestIndex: entry.requestIndex, path: 'redactedText', excerpt: excerpt(redact(textCorpus), 240) });
    }
    if (VERIFY_RE.test(textCorpus)) verificationEvidence = true;
    if (!highTokenEvidence && Number(entry.usage?.totalTokens || 0) >= 180000) {
      highTokenEvidence = {
        requestIndex: entry.requestIndex,
        path: 'usage.totalTokens',
        excerpt: `${entry.usage.totalTokens} tokens in one request`,
      };
    }

    for (const tool of entry.toolCalls || []) {
      const combinedToolText = `${tool.name || ''}\n${tool.inputSummary || ''}\n${tool.resultSummary || ''}`;
      if (tool.status === 'error') failedTools.push({ entry, tool });
      if (DESTRUCTIVE_RE.test(combinedToolText)) destructiveTools.push({ entry, tool });
      const tokenMatch = combinedToolText.match(/Original token count:\s*([0-9]+)/i);
      if (!broadOutputEvidence && tokenMatch && Number(tokenMatch[1]) >= 5000) {
        broadOutputEvidence = evidenceForTool(entry, tool);
      }
      if (VERIFY_RE.test(combinedToolText)) verificationEvidence = true;
    }
  }

  if (failedTools.length > 0) {
    findings.push(finding(
      'rule.failed-tool-results',
      'medium',
      'tool-usage',
      `${failedTools.length} tool result(s) look failed or errored.`,
      failedTools.slice(0, 5).map(({ entry, tool }) => evidenceForTool(entry, tool)),
      'Inspect failed tool outputs and make sure the final answer reports the failure or reruns verification.'
    ));
  }

  if (destructiveTools.length > 0) {
    findings.push(finding(
      'rule.destructive-command',
      'critical',
      'code-safety',
      'Potentially destructive filesystem or Git command detected.',
      destructiveTools.slice(0, 5).map(({ entry, tool }) => evidenceForTool(entry, tool)),
      'Only run destructive commands when the user explicitly requested them and the risk is called out.',
      true
    ));
  }

  if (secretEvidence.length > 0) {
    findings.push(finding(
      'rule.secret-like-content',
      'high',
      'security-privacy',
      'Secret-like content appeared in the auditable transcript.',
      secretEvidence.slice(0, 5),
      'Redact credentials before sending evidence to a reviewer or persisting report excerpts.',
      true
    ));
  }

  const final = latestAssistantText(bundle);
  if (failedTools.length > 0 && COMPLETION_CLAIM_RE.test(final.text)) {
    findings.push(finding(
      'rule.failed-tool-then-success-claim',
      'high',
      'communication-hygiene',
      'Final response appears to claim success after failed tool output.',
      [
        ...failedTools.slice(0, 2).map(({ entry, tool }) => evidenceForTool(entry, tool)),
        ...(final.entry ? [{ requestIndex: final.entry.requestIndex, path: 'assistantText', excerpt: excerpt(final.text, 280) }] : []),
      ],
      'Keep success claims conditional unless the failed command was fixed and rerun successfully.',
      true
    ));
  }

  if (!verificationEvidence && COMPLETION_CLAIM_RE.test(final.text)) {
    findings.push(finding(
      'rule.completion-without-verification',
      'medium',
      'verification',
      'Final response claims completion, but no obvious test/build/lint verification command was found.',
      final.entry ? [{ requestIndex: final.entry.requestIndex, path: 'assistantText', excerpt: excerpt(final.text, 280) }] : [],
      'Include concrete verification evidence in the final response, or explicitly state what could not be verified.'
    ));
  }

  if (broadOutputEvidence) {
    findings.push(finding(
      'rule.large-tool-output',
      'low',
      'context-efficiency',
      'A large tool output was pulled into the session.',
      [broadOutputEvidence],
      'Prefer narrower file reads or targeted searches when the task does not need broad output.'
    ));
  }

  if (highTokenEvidence) {
    findings.push(finding(
      'rule.high-token-pressure',
      'medium',
      'context-efficiency',
      'A single request used a very large token budget.',
      [highTokenEvidence],
      'Audit whether the high context payload was necessary and whether unchanged context can be summarized.'
    ));
  }

  if (findings.length === 0) {
    findings.push(finding(
      'rule.no-deterministic-issues',
      'info',
      'summary',
      'No deterministic rule issues were detected.',
      [],
      'Use the LLM review layer for semantic quality checks that require task understanding.'
    ));
  }

  return findings;
}

function severityRank(severity) {
  return { critical: 5, high: 4, medium: 3, low: 2, info: 1 }[severity] || 0;
}

function overallStatus(findings) {
  if (findings.some(item => item.severity === 'critical' || item.hardGate === true && item.severity === 'high')) return 'fail';
  if (findings.some(item => item.severity === 'high' || item.severity === 'medium')) return 'needs-attention';
  return 'pass';
}

function scorePenalty(findings, categories) {
  let penalty = 0;
  for (const item of findings) {
    if (!categories.includes(item.category)) continue;
    penalty += { critical: 5, high: 3, medium: 2, low: 1, info: 0 }[item.severity] || 0;
  }
  return penalty;
}

export function buildReport(bundle, ruleFindings, reviewerOutput) {
  const sortedFindings = [...ruleFindings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const status = overallStatus(sortedFindings);
  const score = (categories) => Math.max(0, Math.min(5, 5 - scorePenalty(sortedFindings, categories)));
  const categoryScores = {
    taskAlignment: reviewerOutput?.scores?.taskAlignment ?? null,
    toolUse: score(['tool-usage']),
    technicalCorrectness: reviewerOutput?.scores?.technicalCorrectness ?? null,
    verificationQuality: score(['verification', 'communication-hygiene']),
    safetyAndPermissions: score(['code-safety', 'security-privacy']),
    communicationQuality: score(['communication-hygiene']),
    contextEfficiency: score(['context-efficiency']),
    projectRuleCompliance: score(['project-invariants']),
  };
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    overallStatus: status,
    summary: {
      title: status === 'pass'
        ? 'No deterministic hard failures detected'
        : status === 'fail'
          ? 'Hard-gate quality issues detected'
          : 'Some quality concerns need attention',
      ruleFindingCount: sortedFindings.length,
      reviewerStatus: reviewerOutput?.status || 'not_configured',
    },
    metrics: bundle.metrics,
    categoryScores,
    hardGates: sortedFindings.filter(item => item.hardGate),
    ruleFindings: sortedFindings,
    reviewerOutput,
  };
}

function defaultReviewerOutput() {
  return {
    status: 'not_configured',
    reviewer: 'fresh-codex-process',
    message: 'Codex reviewer runner is not configured. The MVP report contains deterministic rule checks and persisted evidence only.',
    findings: [],
    rawOutputPath: null,
  };
}

function storePaths(logDir) {
  const root = join(logDir, 'audits');
  return {
    root,
    indexFile: join(root, 'audit-index.json'),
  };
}

function loadIndex(logDir) {
  const { root, indexFile } = storePaths(logDir);
  ensureDir(root);
  const index = readJson(indexFile, null);
  if (index && typeof index === 'object') {
    return {
      version: AUDIT_STORE_VERSION,
      audits: index.audits && typeof index.audits === 'object' ? index.audits : {},
      dedupe: index.dedupe && typeof index.dedupe === 'object' ? index.dedupe : {},
      updatedAt: index.updatedAt || null,
    };
  }
  return { version: AUDIT_STORE_VERSION, audits: {}, dedupe: {}, updatedAt: null };
}

function saveIndex(logDir, index) {
  const { indexFile } = storePaths(logDir);
  index.updatedAt = nowIso();
  writeJson(indexFile, index);
}

function auditDir(logDir, auditId) {
  const { root } = storePaths(logDir);
  return join(root, `audit_${auditId}`);
}

function createAuditId(sourceRevision) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = randomBytes(4).toString('hex');
  return `aud_${stamp}_${sourceRevision.replace(/^rev_/, '').slice(0, 8)}_${suffix}`;
}

function attemptNumber(index, sourceSessionKey, sourceRevision, auditConfigHash) {
  let count = 0;
  for (const audit of Object.values(index.audits || {})) {
    if (
      audit?.source?.sourceSessionKey === sourceSessionKey &&
      audit?.source?.sourceRevision === sourceRevision &&
      audit?.auditConfigHash === auditConfigHash
    ) {
      count++;
    }
  }
  return count + 1;
}

function sourceSizeFromMeta(sourceMeta = {}) {
  if (Number.isFinite(sourceMeta.size)) return sourceMeta.size;
  if (sourceMeta.filePath) {
    try { return statSync(sourceMeta.filePath).size; } catch {}
  }
  return null;
}

export function createAuditFromEntries(options = {}) {
  const {
    logDir,
    sourceProvider = 'unknown',
    sourceSessionKey = 'current-session',
    sourceLabel = sourceSessionKey,
    entries = [],
    force = false,
    sourceMeta = {},
    reviewerModel = 'not_configured',
  } = options;
  if (!logDir) throw new Error('logDir is required');

  const sourceSize = sourceSizeFromMeta(sourceMeta);
  const sourceRevision = computeSourceRevision({ sourceProvider, sourceSessionKey, entries, sourceSize });
  const auditConfigHash = getAuditConfigHash({ reviewerModel });
  const dedupeKey = hashValue({ sourceProvider, sourceSessionKey, sourceRevision, auditConfigHash }, 'dedupe').slice(0, 71);
  const index = loadIndex(logDir);
  const existingId = index.dedupe[dedupeKey];
  const existing = existingId ? index.audits[existingId] : null;
  if (!force && existing && existsSync(auditDir(logDir, existingId))) {
    return { auditId: existingId, reused: true, audit: getAudit(logDir, existingId) };
  }

  const auditId = createAuditId(sourceRevision);
  const dir = auditDir(logDir, auditId);
  ensureDir(dir);
  const createdAt = nowIso();
  const attempt = attemptNumber(index, sourceSessionKey, sourceRevision, auditConfigHash);
  const source = {
    sourceProvider,
    sourceSessionKey,
    sourceLabel,
    sourceRevision,
    sourceSize,
    entryCount: Array.isArray(entries) ? entries.length : 0,
    lastEntryTimestamp: entries[entries.length - 1]?.timestamp || null,
    trustedSourceType: sourceMeta.type || 'live-session',
  };
  const metadata = {
    auditId,
    status: 'complete',
    stages: [
      { name: 'queued', status: 'complete', at: createdAt },
      { name: 'extracting', status: 'complete', at: createdAt },
      { name: 'rule-checking', status: 'complete', at: createdAt },
      { name: 'reviewing', status: 'skipped', at: createdAt, reason: 'reviewer_not_configured' },
      { name: 'complete', status: 'complete', at: createdAt },
    ],
    source,
    auditConfigHash,
    dedupeKey,
    attempt,
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
  };

  const bundle = buildAuditBundle(entries, source);
  const ruleFindings = runRuleChecks(bundle);
  const reviewerOutput = defaultReviewerOutput();
  const report = buildReport(bundle, ruleFindings, reviewerOutput);

  writeJson(join(dir, 'metadata.json'), metadata);
  writeJson(join(dir, 'evidence-bundle.json'), bundle);
  writeJson(join(dir, 'rule-findings.json'), ruleFindings);
  writeJson(join(dir, 'reviewer-output.json'), reviewerOutput);
  writeJson(join(dir, 'report.json'), report);

  index.audits[auditId] = metadata;
  index.dedupe[dedupeKey] = auditId;
  saveIndex(logDir, index);

  return { auditId, reused: false, audit: getAudit(logDir, auditId) };
}

export function getAudit(logDir, auditId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(auditId || ''))) {
    const err = new Error('Invalid audit id');
    err.code = 'INVALID_AUDIT_ID';
    throw err;
  }
  const dir = auditDir(logDir, auditId);
  if (!existsSync(dir)) {
    const err = new Error('Audit not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return {
    metadata: readJson(join(dir, 'metadata.json'), null),
    evidenceBundle: readJson(join(dir, 'evidence-bundle.json'), null),
    ruleFindings: readJson(join(dir, 'rule-findings.json'), []),
    reviewerOutput: readJson(join(dir, 'reviewer-output.json'), null),
    report: readJson(join(dir, 'report.json'), null),
  };
}
