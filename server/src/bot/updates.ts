/**
 * Приём событий MAX: вебхук (боевой режим) или long polling (локальная отладка).
 * Вебхук отвечает 200 сразу после проверки секрета и идемпотентности, обработка — асинхронно.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Bot, Context, Webhook } from '@maxhub/max-bot-api';
import type { Update, UpdateType } from '@maxhub/max-bot-api/types';
import type { Db } from '../db/index.js';
import { markUpdateSeen, setMeta } from '../db/index.js';

export const UPDATE_TYPES: UpdateType[] = ['message_created', 'message_callback', 'bot_started', 'bot_added', 'bot_removed', 'user_added', 'user_removed', 'bot_stopped', 'dialog_cleared'];

export interface UpdatesDeps { bot: Bot; db: Db; log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void } }

export function updateKey(u: Update): string {
  const anyU = u as unknown as Record<string, unknown>;
  const msg = anyU.message as { body?: { mid?: string } } | undefined;
  const cb = anyU.callback as { callback_id?: string } | undefined;
  const extra = cb?.callback_id ?? msg?.body?.mid ?? String(anyU.chat_id ?? anyU.user_id ?? '');
  return `${u.update_type}:${u.timestamp}:${extra}`;
}

/** Прогон одного события через цепочку обработчиков бота. */
export async function dispatchUpdate(deps: UpdatesDeps, update: Update): Promise<void> {
  if (!markUpdateSeen(deps.db, updateKey(update))) { deps.log.info({ type: update.update_type }, 'duplicate update skipped'); return; }
  setMeta(deps.db, 'last_update_at', new Date().toISOString());
  const ctx = new Context(update, deps.bot.api, deps.bot.botInfo);
  try {
    await deps.bot.middleware()(ctx, () => Promise.resolve());
  } catch (err) {
    deps.log.error({ err: String(err), type: update.update_type }, 'update handler failed');
  }
}

export function webhookPath(botToken: string): string {
  return `/webhook/${Webhook.generateTokenRelatedHash(botToken).slice(0, 32)}`;
}

export function registerWebhook(app: FastifyInstance, deps: UpdatesDeps, opts: { path: string; secret: string | null }): void {
  app.post(opts.path, { config: { rawBody: false }, bodyLimit: 512 * 1024 }, async (req, reply) => {
    const header = req.headers['x-max-bot-api-secret'];
    if (opts.secret) {
      const given = typeof header === 'string' ? Buffer.from(header) : Buffer.alloc(0);
      const expected = Buffer.from(opts.secret);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) { return reply.code(404).send('Not Found'); }
    }
    const update = req.body as Update | undefined;
    if (!update || typeof update !== 'object' || !('update_type' in update)) return reply.code(400).send('Bad Request');
    reply.code(200).send('OK');
    setImmediate(() => { void dispatchUpdate(deps, update); });
  });
}

/** Подписка на вебхук с повторами; возвращает true при успехе. */
export async function ensureSubscription(deps: UpdatesDeps, url: string, secret: string | null): Promise<boolean> {
  try {
    const subs = await deps.bot.api.getSubscriptions();
    const ours = subs.find((s) => s.url === url);
    for (const s of subs) if (s.url !== url) { await deps.bot.api.unsubscribe(s.url).catch(() => undefined); deps.log.warn({ url: s.url }, 'removed foreign subscription'); }
    if (!ours) {
      await deps.bot.api.subscribe(url, secret ?? undefined, UPDATE_TYPES);
      deps.log.info({ url }, 'webhook subscribed');
    }
    setMeta(deps.db, 'webhook_checked_at', new Date().toISOString());
    return true;
  } catch (err) {
    deps.log.error({ err: String(err) }, 'webhook subscription failed');
    return false;
  }
}

/** Long polling для локальной отладки: не трогает чужие подписки и останавливается, если вебхук активен. */
export function startPolling(deps: UpdatesDeps): { stop: () => void } {
  let stopped = false;
  let marker: number | undefined;
  const loop = async () => {
    try {
      const subs = await deps.bot.api.getSubscriptions();
      if (subs.length) { deps.log.warn({ urls: subs.map((s) => s.url) }, 'у бота активен вебхук — long polling недоступен; API и мини-приложение работают'); return; }
    } catch (err) { deps.log.warn({ err: String(err) }, 'getSubscriptions failed'); }
    while (!stopped) {
      try {
        const res = await deps.bot.api.getUpdates(UPDATE_TYPES, { limit: 100, timeout: 30, marker });
        marker = res.marker ?? marker;
        for (const u of res.updates ?? []) await dispatchUpdate(deps, u);
      } catch (err) {
        deps.log.warn({ err: String(err) }, 'polling error, retry in 5s');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  void loop();
  return { stop: () => { stopped = true; } };
}
