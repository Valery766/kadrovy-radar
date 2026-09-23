/**
 * Лимиты входа в API: выдача демо-сессий по IP, тяжёлые расчёты по IP демо-сессии
 * (с учётом доверия к X-Forwarded-For) и защитные заголовки ответа.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { buildApp, type AppParts } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { MarketResult } from '../src/services/market.js';

// Источники в этих тестах не нужны: проверяется только вход в маршрут, поэтому расчёт карточки заглушён.
vi.mock('../src/services/market.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/market.js')>();
  return { ...actual, buildMarket: vi.fn(async () => ({ cardId: 'card-stub' } as unknown as MarketResult)) };
});

const LOOPBACK = '127.0.0.1';
const PROXIED = '203.0.113.9';
const OUTSIDE = '198.51.100.7';

let parts: AppParts | null = null;

async function makeApp(env: Record<string, string> = {}): Promise<AppParts> {
  const config = loadConfig({ MAX_UPDATES_MODE: 'none', PACKS_DIR: resolve(import.meta.dirname, '../../packs'), SESSION_SECRET: 'test', DATA_DIR: '/tmp/stavka-test', ...env });
  parts = await buildApp({ config, dbPath: ':memory:', bot: { username: 'test_bot', userId: 1 }, logger: false, webDist: '/nonexistent' });
  return parts;
}

afterEach(async () => { if (parts) { await parts.app.close(); parts.db.close(); parts = null; } });

const session = (app: AppParts['app'], remoteAddress = LOOPBACK, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/session', payload: {}, remoteAddress, headers });

const market = (app: AppParts['app'], token: string, remoteAddress = LOOPBACK, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/market', payload: { professionKey: 'povar', regionFnsCode: '78' }, remoteAddress, headers: { authorization: `Bearer ${token}`, ...headers } });

describe('лимиты: выдача демо-сессий', () => {
  it('отдаёт не больше 20 сессий в минуту с одного адреса', async () => {
    const { app } = await makeApp();
    for (let i = 1; i <= 20; i += 1) {
      const r = await session(app);
      expect(r.statusCode, `запрос ${i}`).toBe(200);
    }
    const over = await session(app);
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe('rate_limited');
    // Счётчик привязан к адресу: другой клиент лимитом соседа не задет.
    expect((await session(app, OUTSIDE)).statusCode).toBe(200);
  });
});

describe('лимиты: тяжёлые расчёты демо-сессии', () => {
  it('считает попадания по IP, а не по случайному uid демо-сессии', async () => {
    const { app } = await makeApp();
    const token = (await session(app)).json().token as string;
    for (let i = 1; i <= 3; i += 1) {
      const r = await market(app, token);
      expect(r.statusCode, `расчёт ${i}`).toBe(200);
    }
    const over = await market(app, token);
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe('rate_limited');
  });

  it('ведёт отдельный счётчик для каждого X-Forwarded-For от доверенного прокси', async () => {
    const { app } = await makeApp();
    const token = (await session(app)).json().token as string;
    // Исчерпали лимит самого loopback — заголовок доверенного прокси даёт свой счётчик.
    for (let i = 1; i <= 3; i += 1) expect((await market(app, token)).statusCode).toBe(200);
    expect((await market(app, token)).statusCode).toBe(429);

    const xff = { 'x-forwarded-for': PROXIED };
    for (let i = 1; i <= 3; i += 1) {
      const r = await market(app, token, LOOPBACK, xff);
      expect(r.statusCode, `расчёт ${i} через прокси`).toBe(200);
    }
    expect((await market(app, token, LOOPBACK, xff)).statusCode).toBe(429);
  });

  it('игнорирует X-Forwarded-For от недоверенного адреса', async () => {
    const { app } = await makeApp();
    const token = (await session(app)).json().token as string;
    const xff = { 'x-forwarded-for': PROXIED };
    // Лимит для PROXIED исчерпан через доверенный loopback.
    for (let i = 1; i <= 3; i += 1) expect((await market(app, token, LOOPBACK, xff)).statusCode).toBe(200);
    expect((await market(app, token, LOOPBACK, xff)).statusCode).toBe(429);
    // Тот же заголовок от клиента напрямую не учитывается: ключ — адрес сокета, лимит свой.
    expect((await market(app, token, OUTSIDE, xff)).statusCode).toBe(200);
    // И подменой заголовка чужой лимит не сбросить: свой адрес исчерпывается за три запроса.
    expect((await market(app, token, OUTSIDE, xff)).statusCode).toBe(200);
    expect((await market(app, token, OUTSIDE, xff)).statusCode).toBe(200);
    expect((await market(app, token, OUTSIDE, xff)).statusCode).toBe(429);
  });

  it('доверяет X-Forwarded-For при TRUST_PROXY=true', async () => {
    const { app } = await makeApp({ TRUST_PROXY: 'true' });
    const token = (await session(app)).json().token as string;
    const xff = { 'x-forwarded-for': PROXIED };
    for (let i = 1; i <= 3; i += 1) expect((await market(app, token, OUTSIDE, xff)).statusCode).toBe(200);
    expect((await market(app, token, OUTSIDE, xff)).statusCode).toBe(429);
  });
});

describe('защитные заголовки', () => {
  it('ставит nosniff и no-referrer на ответы API', async () => {
    const { app } = await makeApp();
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });
});
