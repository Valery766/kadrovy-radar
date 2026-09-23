/** Точка входа сервера «Ставка»: HTTP API, статика мини-приложения, чат-бот MAX, планировщик. */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Bot } from '@maxhub/max-bot-api';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { loadCatalog } from './packs/loader.js';
import { registerApi } from './api/routes.js';
import { registerBot } from './bot/scenario.js';
import { ensureSubscription, registerWebhook, startPolling, webhookPath, type UpdatesDeps } from './bot/updates.js';
import { startScheduler } from './scheduler/index.js';
import type { MarketContext } from './services/market.js';
import type { ReportContext } from './services/report.js';

async function main() {
  const config = loadConfig();
  const app = Fastify({ logger: { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers["x-max-bot-api-secret"]'] }, trustProxy: true, bodyLimit: 1024 * 1024 });
  const log = app.log;
  const db = openDb(join(config.dataDir, 'stavka.db'));
  const catalog = loadCatalog(config.packsDir);
  log.info({ packs: catalog.packs.map((p) => p.id), regions: catalog.regions.length }, 'пакеты загружены');

  const market: MarketContext = { db, config, catalog, log };
  let bot: Bot | null = null;
  let botInfo: { username: string; userId: number } | null = null;
  if (config.botToken) {
    bot = new Bot(config.botToken, { clientOptions: { baseUrl: config.apiBase } });
    try {
      const me = await bot.api.getMyInfo();
      bot.botInfo = me;
      botInfo = { username: me.username ?? String(me.user_id), userId: me.user_id };
      log.info({ username: me.username, userId: me.user_id }, 'бот подключён');
    } catch (err) {
      log.error({ err: String(err) }, 'не удалось получить GET /me — проверьте MAX_BOT_TOKEN и сертификат Минцифры (NODE_EXTRA_CA_CERTS)');
      if (config.updatesMode !== 'none') throw err;
      bot = null;
    }
  }
  const appUrl = `${config.publicUrl}/app/`;
  const report: ReportContext | null = bot && botInfo ? { db, config, bot, botUsername: botInfo.username } : null;
  if (bot && botInfo) registerBot(bot, { db, market, report: report!, catalog, appUrl, botUsername: botInfo.username, log });

  registerApi(app, { db, config, catalog, market, report, bot: botInfo, startedAt: Date.now() });

  // Статика мини-приложения (сборка Vite) под /app.
  const webDist = resolve(import.meta.dirname, '../../webapp/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/app/', decorateReply: true, setHeaders: (res, path) => { if (path.endsWith('.html')) res.setHeader('cache-control', 'no-cache'); } });
    app.get('/app', (_req, reply) => reply.redirect('/app/'));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/app/') && !req.url.includes('.')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  } else {
    log.warn({ webDist }, 'сборка мини-приложения не найдена — соберите webapp (npm run build -w webapp)');
  }
  app.get('/', (_req, reply) => reply.redirect('/app/'));

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
