/**
 * Кнопки под карточкой рынка в чате: чужой карточкой управлять нельзя, у анонимной карточки
 * (демо-режим браузера, прогрев кэша) автора нет — читать можно, публиковать вакансию нельзя.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Bot, Context } from '@maxhub/max-bot-api';
import type { Update } from '@maxhub/max-bot-api/types';
import { loadConfig } from '../src/config.js';
import { loadCatalog } from '../src/packs/loader.js';
import { openDb, putCard, upsertUser, type Db } from '../src/db/index.js';
import { registerBot } from '../src/bot/scenario.js';
import type { MarketContext, MarketResult } from '../src/services/market.js';
import type { ReportContext } from '../src/services/report.js';

// Отправку PDF заглушаем: проверяется допуск к кнопке, а не отрисовка отчёта и загрузка файла в MAX.
const sentReports = vi.hoisted(() => [] as { cardId: string; userId: number; chatId: number }[]);
vi.mock('../src/services/report.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/report.js')>();
  return {
    ...actual,
    sendReportToChat: vi.fn(async (_ctx: unknown, result: MarketResult, userId: number, chatId: number) => {
      sentReports.push({ cardId: result.cardId, userId, chatId });
      return { mid: 'mid-report', reportId: 'report-1', reused: false };
    }),
  };
});

const OWNER = 501;
const STRANGER = 502;
const CHAT_ID = 900;

// Публикация вакансии рисует QR в DATA_DIR — держим его во временном каталоге и убираем за собой.
const dataDir = mkdtempSync(join(tmpdir(), 'stavka-bot-'));
const config = loadConfig({ MAX_UPDATES_MODE: 'none', PACKS_DIR: resolve(import.meta.dirname, '../../packs'), SESSION_SECRET: 'test', DATA_DIR: dataDir });
const catalog = loadCatalog(config.packsDir);

afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

function cardPayload(cardId: string): MarketResult {
  return {
    cardId,
    card: {
      offer: null,
      stats: { median: 60000, p25: 50000, p75: 70000, min: 40000, max: 90000, mean: 61000 },
      options: [{ kind: 'median', value: 60000 }],
      sample: { vacancies: 30, employers: 12 },
      requirements: [],
      schedules: [],
      histogram: [],
      verdict: { kind: 'ok', text: 'ок' },
    },
    pack: { id: 'generic', title: 'Универсальный', version: 1 },
    profession: { key: 'povar', title: 'Повар', query: 'повар' },
    region: { fnsCode: '78', code: '7800000000000', name: 'Санкт-Петербург' },
    profile: null,
    sources: [],
    fetched: { total: 30, records: 30, cacheHit: true, fetchedAt: new Date().toISOString() },
    closure: null,
    createdAt: new Date().toISOString(),
  } as unknown as MarketResult;
}

interface Harness {
  db: Db;
  acks: { id: string; notification: string | undefined }[];
  replies: string[];
  fire: (payload: string, userId: number) => Promise<void>;
}

let seq = 0;

function harness(): Harness {
  const db = openDb(':memory:');
  const acks: { id: string; notification: string | undefined }[] = [];
  const replies: string[] = [];
  const bot = new Bot('unit-test-bot-token');
  Object.assign(bot.api, {
    setMyCommands: vi.fn(async () => ({ success: true })),
    answerOnCallback: vi.fn(async (id: string, extra?: { notification?: string }) => { acks.push({ id, notification: extra?.notification }); return { success: true }; }),
    sendMessageToChat: vi.fn(async (_chatId: number, text: string) => { replies.push(text); return { body: { mid: `mid-${seq += 1}` } }; }),
    sendAction: vi.fn(async () => ({ success: true })),
    uploadImage: vi.fn(async () => ({ toJson: () => ({}) })),
    uploadFile: vi.fn(async () => ({ toJson: () => ({}) })),
  });
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const market: MarketContext = { db, config, catalog, log } as unknown as MarketContext;
  const report: ReportContext = { db, config, bot, botUsername: 'test_bot' };
  registerBot(bot, { db, market, report, catalog, appUrl: 'https://example.invalid/app/', botUsername: 'test_bot', log });

  const fire = async (payload: string, userId: number) => {
    const ts = Date.now();
    const update = {
      update_type: 'message_callback',
      timestamp: ts,
      callback: { timestamp: ts, callback_id: `cb-${seq += 1}`, payload, user: { user_id: userId, first_name: 'Тест', is_bot: false, last_activity_time: ts } },
      message: {
        timestamp: ts,
        sender: { user_id: userId, first_name: 'Тест', is_bot: false, last_activity_time: ts },
        recipient: { chat_id: CHAT_ID, chat_type: 'dialog' },
        body: { mid: 'm-1', seq: 1, text: '' },
      },
    } as unknown as Update;
    await bot.middleware()(new Context(update, bot.api, bot.botInfo), () => Promise.resolve());
  };
  return { db, acks, replies, fire };
}

const vacancyCount = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM vacancies').get() as { n: number }).n;
const lastAck = (h: Harness) => h.acks.at(-1)?.notification;

describe('бот: кнопки чужой карточки', () => {
  let h: Harness;
  beforeEach(() => {
    sentReports.length = 0;
    h = harness();
    upsertUser(h.db, { maxUserId: OWNER, name: 'Владелец', chatId: CHAT_ID });
    putCard(h.db, { id: 'card-owner', maxUserId: OWNER, inn: '7801633015', packId: 'generic', professionKey: 'povar', regionCode: '7800000000000', offer: null, payload: cardPayload('card-owner') });
    putCard(h.db, { id: 'card-anon', maxUserId: null, inn: null, packId: 'generic', professionKey: 'povar', regionCode: '7800000000000', offer: null, payload: cardPayload('card-anon') });
  });

  it('не даёт опубликовать вакансию по карточке другого пользователя', async () => {
    await h.fire('pub:card-owner', STRANGER);
    expect(lastAck(h)).toBe('Карточка принадлежит другому пользователю');
    expect(vacancyCount(h.db)).toBe(0);
    expect(h.replies).toEqual([]);
  });

  it('закрывает от чужого и PDF, и подписку по карточке владельца', async () => {
    await h.fire('pdf:card-owner', STRANGER);
    expect(lastAck(h)).toBe('Карточка принадлежит другому пользователю');
    expect(sentReports).toEqual([]);
    await h.fire('sub:card-owner', STRANGER);
    expect(lastAck(h)).toBe('Карточка принадлежит другому пользователю');
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get() as { n: number }).n).toBe(0);
  });

  it('по анонимной карточке отклоняет публикацию, но отдаёт PDF и текст вакансии', async () => {
    await h.fire('pub:card-anon', STRANGER);
    expect(lastAck(h)).toBe('Это карточка демо-режима: посчитайте рынок по своему бизнесу — /stavka');
    expect(vacancyCount(h.db)).toBe(0);

    await h.fire('pdf:card-anon', STRANGER);
    expect(lastAck(h)).toBe('Готовлю PDF…');
    expect(sentReports).toEqual([{ cardId: 'card-anon', userId: STRANGER, chatId: CHAT_ID }]);

    await h.fire('text:card-anon', STRANGER);
    expect(lastAck(h)).toBeUndefined();
    expect(h.replies.at(-1)).toContain('Черновик вакансии');
    expect(h.replies.at(-1)).toContain('Повар');
  });

  it('владельцу своя карточка открыта: публикация создаёт вакансию', async () => {
    await h.fire('pub:card-owner', OWNER);
    expect(lastAck(h)).toBe('Публикую вакансию…');
    expect(vacancyCount(h.db)).toBe(1);
    const v = h.db.prepare('SELECT max_user_id AS owner, card_id AS card FROM vacancies').get() as { owner: number; card: string };
    expect(v).toEqual({ owner: OWNER, card: 'card-owner' });
  });

  it('несуществующая карточка — понятный отказ, а не ошибка', async () => {
    await h.fire('pub:card-нет', OWNER);
    expect(lastAck(h)).toBe('Карточка не найдена');
    expect(vacancyCount(h.db)).toBe(0);
  });
});
