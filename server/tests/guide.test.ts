/**
 * Путеводитель: после /start бот присылает два сообщения – короткое приветствие с кнопкой
 * «Проверить ставку» и «Что умеет бот» со всеми пятью возможностями и их командами.
 * То же по кнопке «Что умеет бот» и по /help (плюс группы команд).
 */
import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { Bot, Context } from '@maxhub/max-bot-api';
import type { Update } from '@maxhub/max-bot-api/types';
import { loadConfig } from '../src/config.js';
import { loadCatalog } from '../src/packs/loader.js';
import { openDb } from '../src/db/index.js';
import { registerBot } from '../src/bot/scenario.js';
import { MAX_BUTTON_LABEL } from '../src/bot/texts.js';
import type { MarketContext } from '../src/services/market.js';
import type { ReportContext } from '../src/services/report.js';

const config = loadConfig({ MAX_UPDATES_MODE: 'none', PACKS_DIR: resolve(import.meta.dirname, '../../packs'), SESSION_SECRET: 'test' });
const catalog = loadCatalog(config.packsDir);
const USER = 701;
const CHAT_ID = 910;
const GUIDE_COMMANDS = ['/stavka', '/vacancies', '/jobs'];

interface Reply { text: string; attachments: unknown[] }

/** Подписи всех кнопок вложения-клавиатуры. */
function buttonTexts(attachments: unknown[]): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (typeof o.text === 'string' && typeof o.type === 'string' && o.type !== 'inline_keyboard') out.push(o.text);
      Object.values(o).forEach(walk);
    }
  };
  walk(attachments);
  return out;
}

function harness() {
  const db = openDb(':memory:');
  const replies: Reply[] = [];
  const bot = new Bot('unit-test-bot-token');
  let seq = 0;
  Object.assign(bot.api, {
    setMyCommands: vi.fn(async () => ({ success: true })),
    answerOnCallback: vi.fn(async () => ({ success: true })),
    sendMessageToChat: vi.fn(async (_chatId: number, text: string, extra?: { attachments?: unknown[] }) => { replies.push({ text, attachments: extra?.attachments ?? [] }); return { body: { mid: `mid-${seq += 1}` } }; }),
    sendAction: vi.fn(async () => ({ success: true })),
  });
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const market = { db, config, catalog, log } as unknown as MarketContext;
  const report: ReportContext = { db, config, bot, botUsername: 'test_bot' };
  registerBot(bot, { db, market, report, catalog, appUrl: 'https://example.invalid/app/', botUsername: 'test_bot', log });
  const send = (update: Record<string, unknown>) => bot.middleware()(new Context(update as unknown as Update, bot.api, bot.botInfo), () => Promise.resolve());
  const user = () => ({ user_id: USER, first_name: 'Валерий', is_bot: false, last_activity_time: Date.now() });
  const message = (text: string) => {
    const ts = Date.now();
    return send({ update_type: 'message_created', timestamp: ts, message: { timestamp: ts, sender: user(), recipient: { chat_id: CHAT_ID, chat_type: 'dialog' }, body: { mid: `m-${seq += 1}`, seq: 1, text } } });
  };
  const started = () => send({ update_type: 'bot_started', timestamp: Date.now(), chat_id: CHAT_ID, user: user() });
  const callback = (payload: string) => {
    const ts = Date.now();
    return send({
      update_type: 'message_callback', timestamp: ts,
      callback: { timestamp: ts, callback_id: `cb-${seq += 1}`, payload, user: user() },
      message: { timestamp: ts, sender: user(), recipient: { chat_id: CHAT_ID, chat_type: 'dialog' }, body: { mid: 'm-cb', seq: 1, text: '' } },
    });
  };
  return { replies, message, started, callback };
}

const expectGuide = (text: string) => {
  expect(text).toContain('Что умеет бот');
  for (const cmd of GUIDE_COMMANDS) expect(text).toContain(cmd);
  expect(text).toContain('Что дальше');
  expect(text).not.toContain('—');
};

describe('путеводитель', () => {
  it('/start: одно короткое приветствие с основными действиями, без дублирующей справки', async () => {
    const h = harness();
    await h.message('/start');
    expect(h.replies).toHaveLength(1);
    const welcome = h.replies[0]!;
    expect(welcome.text).toContain('Валерий');
    expect(welcome.text).toContain('Кадровый радар');
    expect(welcome.text.split('\n').filter(Boolean).length).toBeLessThanOrEqual(3);
    expect(welcome.text).not.toContain('—');
    const welcomeButtons = buttonTexts(welcome.attachments);
    expect(welcomeButtons[0]).toBe('Проверить ставку');
    expect(welcomeButtons).toContain('Что умеет бот');
    expect(welcomeButtons).toContain('Найти работу');
    expect(welcomeButtons).toContain('Мои вакансии');
  });

  it('bot_started без payload: одно приветствие', async () => {
    const h = harness();
    await h.started();
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]!.text).toContain('Кадровый радар');
  });

  it('кнопка «Что умеет бот» и /help повторяют путеводитель; /help добавляет группы команд', async () => {
    const h = harness();
    await h.callback('guide');
    expect(h.replies).toHaveLength(1);
    expectGuide(h.replies[0]!.text);
    await h.message('/help');
    const help = h.replies.at(-1)!.text;
    expectGuide(help);
    for (const group of ['Основное:', 'Ещё:', 'Настройки и справка:']) expect(help).toContain(group);
    for (const cmd of ['/subs', '/demo', '/profile', '/help']) expect(help).toContain(cmd);
    expect(help.length).toBeLessThanOrEqual(4000);
  });

  it('все подписи кнопок не длиннее лимита клавиатуры', async () => {
    const h = harness();
    await h.message('/start');
    await h.message('/help');
    await h.callback('stavka');
    const labels = h.replies.flatMap((r) => buttonTexts(r.attachments));
    expect(labels.length).toBeGreaterThan(5);
    for (const label of labels) expect(label.length, label).toBeLessThanOrEqual(MAX_BUTTON_LABEL);
  });

  it('/stavka ведёт по шагам: первый вопрос подписан «Шаг 1 из 3» и заканчивается блоком «Что дальше»', async () => {
    const h = harness();
    await h.message('/stavka');
    const text = h.replies.at(-1)!.text;
    expect(text).toContain('Шаг 1 из 3');
    expect(text).toContain('Что дальше');
    expect(buttonTexts(h.replies.at(-1)!.attachments)).toEqual(['Без ИНН, укажу регион']);
  });
});
