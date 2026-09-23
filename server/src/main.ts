/** Точка входа сервера «Ставка»: HTTP API, статика мини-приложения, чат-бот MAX, планировщик. */
import { Bot } from '@maxhub/max-bot-api';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { registerBot } from './bot/scenario.js';
import { botFetch } from './bot/client.js';
import { drainUpdates, ensureSubscription, registerWebhook, startPolling, webhookPath, type UpdatesDeps } from './bot/updates.js';
import { startScheduler, type SchedulerDeps } from './scheduler/index.js';

type BotInfo = { username: string; userId: number };

/** Паузы между повторами GET /me, когда MAX API недоступен: 5, 10, 30 с, дальше раз в минуту. */
const RECONNECT_DELAYS_MS = [5_000, 10_000, 30_000, 60_000];
/** Сколько ждать незавершённые обработчики событий при остановке. */
const DRAIN_TIMEOUT_MS = 10_000;

async function main() {
  const config = loadConfig();

  // Бот создаём до HTTP-приложения: его username нужен кнопкам и API. Клиент – с таймаутом на каждый вызов Bot API.
  const bot = config.botToken ? new Bot(config.botToken, { clientOptions: { baseUrl: config.apiBase, fetch: botFetch } }) : null;

  const fetchBotInfo = async (): Promise<BotInfo> => {
    const me = await bot!.api.getMyInfo();
    bot!.botInfo = me;
    return { username: me.username ?? String(me.user_id), userId: me.user_id };
  };

  // Первая попытка – сразу. Неудача не роняет процесс (иначе systemd/compose крутили бы рестарты, а мини-приложение
  // и /api/health от MAX API не зависят): HTTP поднимается, бот подключается в фоне.
  let botInfo: BotInfo | null = null;
  if (bot) {
    try {
      botInfo = await fetchBotInfo();
    } catch (err) {
      console.error('не удалось получить GET /me – проверьте MAX_BOT_TOKEN и сертификат Минцифры (NODE_EXTRA_CA_CERTS); повторю подключение в фоне:', String(err));
    }
  }

  const parts = await buildApp({ config, bot: botInfo, report: null });
  const { app, db, catalog, market, apiDeps } = parts;
  const log = app.log;
  log.info({ packs: catalog.packs.map((p) => p.id), regions: catalog.regions.length }, 'пакеты загружены');

  // Маршрут вебхука регистрируется до listen (позже Fastify маршруты не принимает); пока бот не подключён – 503, MAX повторит доставку.
  const updates: UpdatesDeps | null = bot ? { bot, db, log } : null;
  let webhook: { url: string; secret: string | null } | null = null;
  if (bot && updates && config.updatesMode === 'webhook') {
    const path = webhookPath(config.botToken!);
    webhook = { url: `${config.publicUrl}${path}`, secret: config.webhookSecret };
    registerWebhook(app, updates, { path, secret: config.webhookSecret, ready: () => botInfo != null });
  }

  const scheduler: SchedulerDeps = { db, market, bot: null, botUsername: null, updates: null, webhook: null, log };
  let polling: { stop: () => void } | null = null;
  let stopping = false;

  /** Бот подключён: контексты API, обработчики сценария, вебхук или long polling, задачи планировщика. */
  const onBotReady = async (info: BotInfo) => {
    if (!bot || !updates) return;
    botInfo = info;
    log.info({ username: info.username, userId: info.userId }, 'бот подключён');
    apiDeps.bot = info; // маршруты читают deps.bot при каждом запросе
    const report = { db, config, bot, botUsername: info.username };
    apiDeps.report = report;
    apiDeps.hiring = { db, config, bot, botUsername: info.username }; // тот же бот пишет кандидатам по действиям из мини-приложения
    registerBot(bot, { db, market, report, catalog, appUrl: `${config.publicUrl}/app/`, botUsername: info.username, log });
    scheduler.bot = bot;
    scheduler.botUsername = info.username;
    if (config.updatesMode === 'webhook' && webhook) {
      scheduler.updates = updates;
      scheduler.webhook = webhook;
      const ok = await ensureSubscription(updates, webhook.url, webhook.secret);
      if (!ok) log.error('вебхук не зарегистрирован – сторож повторит через 10 минут');
    }
    if (config.updatesMode === 'polling') polling = startPolling(updates);
  };

  /** Повторы GET /me в фоне с нарастающей паузой, пока не подключимся или не начнём останавливаться. */
  const reconnect = async () => {
    for (let attempt = 0; !stopping; attempt += 1) {
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
      await new Promise((r) => setTimeout(r, delay));
      if (stopping) return;
      try {
        const info = await fetchBotInfo();
        await onBotReady(info);
        return;
      } catch (err) {
        log.warn({ err: String(err), attempt: attempt + 1 }, 'MAX API недоступен – повторю подключение бота');
      }
    }
  };

  await app.listen({ port: config.port, host: config.host });
  log.info({ port: config.port, mode: config.updatesMode, publicUrl: config.publicUrl, bot: botInfo?.username ?? null }, 'сервер запущен');

  if (bot && botInfo) await onBotReady(botInfo);
  else if (bot) void reconnect();

  const stopScheduler = startScheduler(scheduler);

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'остановка');
    stopScheduler();
    polling?.stop();
    await app.close();
    // Вебхук уже ответил 200 и записал ключ события – MAX его не повторит, поэтому обработчики дожидаемся.
    const left = await drainUpdates(DRAIN_TIMEOUT_MS);
    if (left > 0) log.warn({ left }, 'остановка: не все обработчики событий успели завершиться');
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
