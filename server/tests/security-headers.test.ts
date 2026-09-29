import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { buildApp, MINIAPP_CSP, type AppParts } from '../src/app.js';
import { loadConfig } from '../src/config.js';
let parts: AppParts;
beforeAll(async () => {
  const config = loadConfig({ MAX_UPDATES_MODE: 'none', PACKS_DIR: resolve(import.meta.dirname, '../../packs'), SESSION_SECRET: 'synthetic-unit-test', MAX_BOT_TOKEN: 'synthetic-test-token', DATA_DIR: '/tmp/stavka-security-test' });
  parts = await buildApp({ config, dbPath: ':memory:', logger: false, webDist: '/nonexistent' });
  parts.app.get('/test-html', (_req, reply) => reply.type('text/html').send('<!doctype html><title>Test</title>'));
});
afterAll(async () => { await parts.app.close(); parts.db.close(); });
describe('HTML security headers without breaking MAX embedding', () => {
  it('sets CSP, nosniff and no-referrer on HTML', async () => {
    const r = await parts.app.inject('/test-html');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toBe(MINIAPP_CSP);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });
  it('allows only MAX/self parents and the documented bridge, not arbitrary scripts/eval/inline', () => {
    expect(MINIAPP_CSP).toContain("frame-ancestors 'self' https://web.max.ru https://max.ru");
    expect(MINIAPP_CSP).toContain("script-src 'self' https://st.max.ru");
    expect(MINIAPP_CSP).toContain("style-src 'self'");
    expect(MINIAPP_CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(MINIAPP_CSP).toContain("object-src 'none'");
    expect(MINIAPP_CSP).toContain("base-uri 'none'");
  });
  it('does not set SAMEORIGIN/DENY or invent CSP requirements on JSON API responses', async () => {
    expect((await parts.app.inject('/test-html')).headers['x-frame-options']).toBeUndefined();
    const r = await parts.app.inject('/api/health');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toBeUndefined();
    expect((await parts.app.inject('/api/bootstrap')).statusCode).toBe(401);
  });
});
