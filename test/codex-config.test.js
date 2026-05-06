import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCodexConfigToml, readCodexProviderConfig } from '../lib/codex-config.js';

describe('codex-config', () => {
  it('parses active model provider and Raven Responses config', () => {
    const parsed = parseCodexConfigToml(`
model_provider = "raven"

[model_providers.raven]
base_url = "http://localhost:7024/v1"
wire_api = "responses"
env_key = "RAVEN_API_KEY"
`);

    assert.equal(parsed.model_provider, 'raven');
    assert.equal(parsed.model_providers.raven.base_url, 'http://localhost:7024/v1');
    assert.equal(parsed.model_providers.raven.wire_api, 'responses');
  });

  it('reads config.toml from CODEX_HOME style directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccv-codex-config-'));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'config.toml'), `
model_provider = "raven"
[model_providers.raven]
base_url = "http://localhost:7024/v1"
wire_api = "responses"
`);
      const result = readCodexProviderConfig({ codexHome: root });
      assert.equal(result.provider, 'raven');
      assert.equal(result.baseUrl, 'http://localhost:7024/v1');
      assert.equal(result.wireApi, 'responses');
      assert.equal(result.configPath, join(root, 'config.toml'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults to Raven localhost when config is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccv-codex-config-missing-'));
    try {
      const result = readCodexProviderConfig({ codexHome: root });
      assert.equal(result.provider, 'raven');
      assert.equal(result.baseUrl, 'http://localhost:7024/v1');
      assert.equal(result.wireApi, 'responses');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
