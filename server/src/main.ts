/** Точка входа сервера «Ставка»: HTTP API, статика мини-приложения, чат-бот MAX, планировщик. */
import { Bot } from '@maxhub/max-bot-api';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { registerBot } from './bot/scenario.js';
import { ensureSubscription, registerWebhook, startPolling, webhookPath, type UpdatesDeps } from './bot/updates.js';
import { startScheduler } from './scheduler/index.js';
import type { ReportContext } from './services/report.js';

async function main() {
  const config = loadConfig();

  // Бот создаём до HTTP-приложения: его username нужен кнопкам и API.
  let bot: Bot | null = null;
  let botInfo: { username: string; userId: number } | null = null;
  if (config.botToken) {
    bot = new Bot(config.botToken, { clientOptions: { baseUrl: config.apiBase } });
    try {
      const me = await bot.api.getMyInfo();
      bot.botInfo = me;
      botInfo = { username: me.username ?? String(me.user_id), userId: me.user_id };
    } catch (err) {
      console.error('не удалось получить GET /me — проверьте MAX_BOT_TOKEN и сертификат Минцифры (NODE_EXTRA_CA_CERTS):', String(err));
      if (config.updatesMode !== 'none') throw err;
      bot = null;
    }
  }

  // Контекст отчёта ссылается на db, поэтому собираем его после buildApp.
  let report: ReportContext | null = null;
  const parts = await buildApp({ config, bot: botInfo, report: null });
  const { app, db, catalog, market, apiDeps } = parts;
  const log = app.log;
  log.info({ packs: catalog.packs.map((p) => p.id), regions: catalog.regions.length }, 'пакеты загружены');
  if (botInfo) log.info({ username: botInfo.username, userId: botInfo.userId }, 'бот подключён');

  if (bot && botInfo) {
    report = { db, config, bot, botUsername: botInfo.username };
    apiDeps.report = report; // маршруты читают deps.report при каждом запросе
    registerBot(bot, { db, market, report, catalog, appUrl: `${config.publicUrl}/app/`, botUsername: botInfo.username, log });
  }

  let updates: UpdatesDeps | null = null;
  let webhook: { url: string; secret: string | null } | null = null;
  if (bot && config.updatesMode === 'webhook') {
    updates = { bot, db, log };
    const path = webhookPath(config.botToken!);
    webhook = { url: `${config.publicUrl}${path}`, secret: config.webhookSecret };
    registerWebhook(app, updates, { path, secret: config.webhookSecret });
  }

  await app.listen({ port: config.port, host: config.host });
  log.info({ port: config.port, mode: config.updatesMode, publicUrl: config.publicUrl }, 'сервер запущен');

  if (bot && updates && webhook) {
    const ok = await ensureSubscription(updates, webhook.url, webhook.secret);
    if (!ok) log.error('вебхук не зарегистрирован — сторож повторит через 10 минут');
  }
  let polling: { stop: () => void } | null = null;
  if (bot && config.updatesMode === 'polling') {
    updates = { bot, db, log };
    polling = startPolling(updates);
  }
  const stopScheduler = startScheduler({ db, market, bot, botUsername: botInfo?.username ?? null, updates, webhook, log });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'остановка');
    stopScheduler();
    polling?.stop();
    await app.close();
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
