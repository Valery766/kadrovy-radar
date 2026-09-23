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

describe('api: свободный ввод должности', () => {
  it('suggests professions offline: catalog first, then OKPDTR', async () => {
    expect((await get('/api/professions/suggest?q=повар')).statusCode).toBe(401);
    const token = (await post('/api/session', {})).json().token as string;
    const r = await get('/api/professions/suggest?q=повар&limit=5', token);
    expect(r.statusCode).toBe(200);
    const { suggestions } = r.json() as { suggestions: { key: string; title: string; source: string; code?: string }[] };
    expect(suggestions.length).toBeGreaterThan(1);
    expect(suggestions.length).toBeLessThanOrEqual(5);
    expect(suggestions[0]!.key).toBe('povar');
    expect(suggestions[0]!.source).toBe('catalog');
    expect(suggestions.some((x) => x.source === 'okpdtr' && x.code)).toBe(true);
    // Слишком короткий запрос не гоняет справочник.
    expect(((await get('/api/professions/suggest?q=п', token)).json() as { suggestions: unknown[] }).suggestions).toEqual([]);
  });

  it('refuses a custom profession key without its text', async () => {
    const token = (await post('/api/session', {})).json().token as string;
    const r = await post('/api/market', { professionKey: 'custom:obvalshchik-1234567890ab', regionFnsCode: '78' }, token);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('profession_text_required');
    expect(r.json().message).toContain('professionText');
    // Пустой текст и пустой ключ — тоже понятная ошибка, а не 500.
    expect((await post('/api/market', { professionText: '   ', regionFnsCode: '78' }, token)).json().error).toBe('profession_required');
    expect((await post('/api/market', { professionKey: 'kosmonavt' }, token)).json().error).toBe('profession_unknown');
  });
});

describe('api: штат', () => {
  it('validates the staff list before touching the sources', async () => {
    const token = (await post('/api/session', {})).json().token as string;
    expect((await post('/api/staff', { positions: [] }, token)).json().error).toBe('positions_required');
    const many = Array.from({ length: 21 }, (_, i) => ({ title: `должность ${i}`, salary: 50000 }));
    expect((await post('/api/staff', { positions: many }, token)).json().error).toBe('too_many_positions');
    expect((await post('/api/staff', { positions: [{ title: '', salary: 50000 }] }, token)).json().error).toBe('position_invalid');
    expect((await post('/api/staff', { positions: [{ title: 'повар', salary: 5 }] }, token)).json().error).toBe('position_invalid');
    // Без региона и ИНН сравнивать не с чем.
    const r = await post('/api/staff', { positions: [{ title: 'повар', salary: 50000 }] }, token);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('region_required');
  });

  it('has no saved report for a demo session', async () => {
    const token = (await post('/api/session', {})).json().token as string;
    const r = await get('/api/staff', token);
    expect(r.statusCode).toBe(200);
    expect(r.json().report).toBeNull();
  });
});

describe('api: регионы', () => {
  it('validates the region list', async () => {
    const token = (await post('/api/session', {})).json().token as string;
    expect((await post('/api/regions/compare', { professionKey: 'povar', regionFnsCodes: [] }, token)).json().error).toBe('regions_required');
    const nine = ['78', '77', '16', '23', '66', '54', '52', '50', '47'];
    const tooMany = await post('/api/regions/compare', { professionKey: 'povar', regionFnsCodes: nine }, token);
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error).toBe('too_many_regions');
    expect((await post('/api/regions/compare', { regionFnsCodes: ['78'] }, token)).json().error).toBe('profession_required');
  });

  it('keeps unknown regions in the table instead of failing the request', async () => {
    const token = (await post('/api/session', {})).json().token as string;
    const r = await post('/api/regions/compare', { professionKey: 'povar', regionFnsCodes: ['00', '97'] }, token);
    expect(r.statusCode).toBe(200);
    const body = r.json() as { comparison: { rows: { fnsCode: string; error: string | null }[]; summary: { withData: number; failed: number } }; text: string };
    expect(body.comparison.rows.map((x) => x.fnsCode).sort()).toEqual(['00', '97']);
    expect(body.comparison.rows.every((x) => x.error)).toBe(true);
    expect(body.comparison.summary.withData).toBe(0);
    expect(body.comparison.summary.failed).toBe(2);
    expect(body.text).toContain('Повар');
  });

  it('rejects a digest for an unknown region and survives an unknown profession', async () => {
    const token = (await post('/api/session', {})).json().token as string;
    const bad = await get('/api/regions/00/digest', token);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('region_unknown');
    const r = await get('/api/regions/78/digest?professions=kosmonavt', token);
    expect(r.statusCode).toBe(200);
    const body = r.json() as { region: { name: string }; rows: { professionKey: string; error: string | null }[] };
    expect(body.region.name).toBe('Санкт-Петербург');
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.error).toBeTruthy();
  });
});
