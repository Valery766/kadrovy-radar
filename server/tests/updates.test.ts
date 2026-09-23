/**
 * Приём событий MAX: вебхук отвечает 200 до обработки, поэтому при остановке процесса
 * незавершённые обработчики нужно дождаться — за этим следят pendingUpdates и drainUpdates.
 */
import { describe, expect, it, vi } from 'vitest';
import { Bot } from '@maxhub/max-bot-api';
import type { Update } from '@maxhub/max-bot-api/types';
import { openDb, type Db } from '../src/db/index.js';
import { dispatchUpdate, drainUpdates, pendingUpdates, type UpdatesDeps } from '../src/bot/updates.js';

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

function makeUpdate(mid: string): Update {
  const ts = Date.now();
  return {
    update_type: 'message_created',
    timestamp: ts,
    message: {
      timestamp: ts,
      sender: { user_id: 77, first_name: 'Тест', is_bot: false, last_activity_time: ts },
      recipient: { chat_id: 700, chat_type: 'dialog' },
      body: { mid, seq: 1, text: 'привет' },
    },
  } as unknown as Update;
}

function makeDeps(handler: () => Promise<void>): { deps: UpdatesDeps; db: Db; calls: () => number } {
  const db = openDb(':memory:');
  const bot = new Bot('unit-test-bot-token');
  Object.assign(bot.api, { sendMessageToChat: vi.fn(async () => ({ body: { mid: 'm' } })) });
  let calls = 0;
  bot.use(async () => { calls += 1; await handler(); });
  return { deps: { bot, db, log: silentLog }, db, calls: () => calls };
}

describe('обработка событий: ожидание при остановке', () => {
  it('считает обработчики в работе и возвращает остаток, если ждать некогда', async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((r) => { release = () => r(); });
    const { deps, db } = makeDeps(() => gate);

    expect(pendingUpdates()).toBe(0);
    expect(await drainUpdates(200)).toBe(0);

    const running = dispatchUpdate(deps, makeUpdate('mid.slow'));
    expect(pendingUpdates()).toBe(1);

    // Ждать некогда: drainUpdates отдаёт остаток, а не зависает до конца обработки.
    const started = Date.now();
    expect(await drainUpdates(150)).toBe(1);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(pendingUpdates()).toBe(1);

    release();
    await running;
    expect(pendingUpdates()).toBe(0);
    expect(await drainUpdates(200)).toBe(0);
    db.close();
  });

  it('не роняет счётчик при ошибке обработчика и пропускает повторную доставку', async () => {
    const { deps, db, calls } = makeDeps(async () => { throw new Error('обработчик упал'); });
    const update = makeUpdate('mid.dup');

    await dispatchUpdate(deps, update);
    expect(calls()).toBe(1);
    expect(pendingUpdates()).toBe(0);

    // MAX доставляет одно событие до 10 раз: второй раз обработчик не вызывается.
    await dispatchUpdate(deps, update);
    expect(calls()).toBe(1);
    expect(pendingUpdates()).toBe(0);
    db.close();
  });
});
