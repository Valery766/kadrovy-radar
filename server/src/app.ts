/** Сборка HTTP-приложения без запуска слушателя — используется main.ts и тестами (fastify.inject). */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from './config.js';
import { openDb, type Db } from './db/index.js';
import { loadCatalog, type PackCatalog } from './packs/loader.js';
import { registerApi, type ApiDeps } from './api/routes.js';
import type { MarketContext } from './services/market.js';
import type { ReportContext } from './services/report.js';

export interface AppParts {
  app: FastifyInstance;
  db: Db;
  catalog: PackCatalog;
  market: MarketContext;
  /** Зависимости API; поле report можно выставить после сборки (маршруты читают его при каждом запросе). */
  apiDeps: ApiDeps;
}

export interface BuildAppOptions {
  config: Config;
  dbPath?: string;
  report?: ReportContext | null;
  bot?: { username: string; userId: number } | null;
  webDist?: string;
  logger?: boolean | object;
}

export async function buildApp(opts: BuildAppOptions): Promise<AppParts> {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger ?? { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers["x-max-bot-api-secret"]'] },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  const db = openDb(opts.dbPath ?? join(config.dataDir, 'stavka.db'));
  const catalog = loadCatalog(config.packsDir);
  const market: MarketContext = { db, config, catalog, log: app.log };

  const apiDeps: ApiDeps = { db, config, catalog, market, report: opts.report ?? null, bot: opts.bot ?? null, startedAt: Date.now() };
  registerApi(app, apiDeps);

  const webDist = opts.webDist ?? resolve(import.meta.dirname, '../../webapp/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/app/', decorateReply: true, setHeaders: (res, path) => { if (path.endsWith('.html')) res.setHeader('cache-control', 'no-cache'); } });
    app.get('/app', (_req, reply) => reply.redirect('/app/'));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/app/') && !req.url.includes('.')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  } else {
    app.log.warn({ webDist }, 'сборка мини-приложения не найдена — соберите webapp (npm run build -w webapp)');
  }
  app.get('/', (_req, reply) => reply.redirect('/app/'));
  return { app, db, catalog, market, apiDeps };
}
