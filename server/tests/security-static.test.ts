import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp, type AppParts } from '../src/app.js';
import { loadConfig } from '../src/config.js';
const dir = mkdtempSync(join(tmpdir(), 'max-static-security-'));
let parts: AppParts;
beforeAll(async () => {
  const publicDir = join(dir, 'public'); mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>PUBLIC_TEST_PAGE</title>');
  writeFileSync(join(dir, 'private.txt'), 'PRIVATE_FIXTURE_MUST_NOT_BE_SERVED');
  const config = loadConfig({ MAX_UPDATES_MODE: 'none', SESSION_SECRET: 'unit-test-static-secret', PACKS_DIR: resolve(import.meta.dirname, '../../packs') });
  parts = await buildApp({ config, dbPath: ':memory:', logger: false, webDist: publicDir });
});
afterAll(async () => { if (parts) { await parts.app.close(); parts.db.close(); } rmSync(dir, { recursive: true, force: true }); });
describe('static security upgrade', () => {
  it('serves HTML with no-cache and security headers after the plugin API change', async () => {
    const r = await parts.app.inject('/app/');
    expect(r.statusCode).toBe(200); expect(r.body).toContain('PUBLIC_TEST_PAGE');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
  });
  it('does not expose a file outside the static root with traversal or encoded separators', async () => {
    for (const path of ['/app/../private.txt', '/app/%2e%2e/private.txt', '/app/%2e%2e%2fprivate.txt', '/app/%252e%252e%252fprivate.txt', '/app/%2e%2e%5cprivate.txt']) {
      const r = await parts.app.inject(path);
      expect(r.body).not.toContain('PRIVATE_FIXTURE_MUST_NOT_BE_SERVED');
      expect([400, 403, 404]).toContain(r.statusCode);
    }
  });
});
