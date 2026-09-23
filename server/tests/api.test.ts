import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { buildApp, type AppParts } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildSignedInitData } from '../src/api/auth.js';

const TOKEN = 'unit-test-bot-token';
let parts: AppParts;

beforeAll(async () => {
  const config = loadConfig({ MAX_UPDATES_MODE: 'none', PACKS_DIR: resolve(import.meta.dirname, '../../packs'), SESSION_SECRET: 'test', MAX_BOT_TOKEN: TOKEN, DATA_DIR: '/tmp/stavka-test' });
  parts = await buildApp({ config, dbPath: ':memory:', bot: { username: 'test_bot', userId: 1 }, logger: false, webDist: '/nonexistent' });
});
afterAll(async () => { await parts.app.close(); parts.db.close(); });

const post = (url: string, body: unknown, token?: string) => parts.app.inject({ method: 'POST', url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
const get = (url: string, token?: string) => parts.app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('api', () => {
  it('reports health and packs', async () => {
    const r = await get('/api/health');
    expect(r.statusCode).toBe(200);
    expect(r.json().packs).toContain('spb-obschepit');
  });
  it('issues a demo session without initData and rejects requests without a session', async () => {
    const r = await post('/api/session', {});
    expect(r.statusCode).toBe(200);
    expect(r.json().user.demo).toBe(true);
    expect((await get('/api/bootstrap')).statusCode).toBe(401);
    expect((await get('/api/bootstrap', 'garbage.token')).statusCode).toBe(401);
  });
  it('accepts valid initData and rejects a forged one', async () => {
    const now = Math.floor(Date.now() / 1000);
    const good = buildSignedInitData(TOKEN, { auth_date: String(now), chat: '{"id":777,"type":"DIALOG"}', query_id: 'q', user: '{"id":4242,"first_name":"Тест"}', start_param: 'card_x' });
    const ok = await post('/api/session', { initData: good });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user).toMatchObject({ id: 4242, demo: false, chatId: 777 });
    expect(ok.json().startParam).toBe('card_x');
    const bad = await post('/api/session', { initData: good.replace('4242', '4243') });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().reason).toBe('bad_signature');
  });
  it('serves bootstrap with packs, regions and the user', async () => {
    const token = (await post('/api/session', {})).json().token as string;
    const r = await get('/api/bootstrap', token);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    // Пакеты — переменная часть: проверяем наличие базовых, а не точный список.
    expect(b.packs.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(['generic', 'spb-obschepit', 'tatarstan-roznitsa']));
    expect(b.regions.length).toBe(91);
    expect(b.user.demo).toBe(true);
    expect(b.bot.username).toBe('test_bot');
  });
  it('validates input: bad INN, missing profession, bad offer, unknown card', async () => {
    const token = (await post('/api/session', {})).json().token as string;
    expect((await post('/api/profile', { inn: '123' }, token)).statusCode).toBe(400);
    expect((await post('/api/market', { offer: 45000 }, token)).statusCode).toBe(400);
    expect((await post('/api/market', { professionKey: 'povar', offer: 5 }, token)).statusCode).toBe(400);
    expect((await get('/api/cards/nope', token)).statusCode).toBe(404);
    expect((await post('/api/cards/nope/report', {}, token)).statusCode).toBe(400);
  });
  it('returns 404 JSON for unknown routes', async () => {
    const r = await get('/api/unknown');
    expect(r.statusCode).toBe(404);
  });
});
