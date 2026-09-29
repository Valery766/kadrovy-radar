/** Сборка HTTP-приложения без запуска слушателя – используется main.ts и тестами (fastify.inject). */
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
import type { HiringContext } from './services/hiring.js';

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
  hiring?: HiringContext | null;
  bot?: { username: string; userId: number } | null;
  webDist?: string;
  logger?: boolean | object;
}

/** Allow the documented MAX bridge and real MAX web parents, not arbitrary framing or scripts.
 * React applies dynamic chart styles via DOM properties; bundled stylesheets are same-origin.
 * Do not add X-Frame-Options: SAMEORIGIN/DENY would break the cross-origin MAX miniapp.
 */
export const MINIAPP_CSP = [
  "default-src 'none'",
  "script-src 'self' https://st.max.ru",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'self' https://web.max.ru https://max.ru",
].join('; ');

/**
 * В журнал запросов не попадает строка запроса: в ней бывают ИНН (`/api/inspections?inn=…`)
 * и свободный текст подсказок (`?q=…`), а ИНН ИП – персональные данные.
 */
function requestSerializer(req: { method: string; url: string; ip: string }) {
  const q = req.url.indexOf('?');
  return { method: req.method, url: q === -1 ? req.url : `${req.url.slice(0, q)}?…`, remoteAddress: req.ip };
}

export async function buildApp(opts: BuildAppOptions): Promise<AppParts> {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger ?? {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers["x-max-bot-api-secret"]'],
      serializers: { req: requestSerializer },
    },
    // X-Forwarded-For принимается только от доверенных прокси (по умолчанию loopback – nginx на том же хосте):
    // иначе лимиты демо-режима по IP обходились бы одним заголовком.
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });
  // Shared headers; HTML receives a CSP with a narrow MAX frame allowlist below.
  app.addHook('onRequest', (_req, reply, done) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    done();
  });
  app.addHook('onSend', (_req, reply, payload, done) => {
    if (String(reply.getHeader('content-type') ?? '').includes('text/html') && !reply.hasHeader('content-security-policy')) {
      reply.header('content-security-policy', MINIAPP_CSP);
    }
    done(null, payload);
  });
  const db = openDb(opts.dbPath ?? join(config.dataDir, 'stavka.db'));
  const catalog = loadCatalog(config.packsDir);
  const market: MarketContext = { db, config, catalog, log: app.log };

  const apiDeps: ApiDeps = { db, config, catalog, market, report: opts.report ?? null, hiring: opts.hiring ?? null, bot: opts.bot ?? null, startedAt: Date.now() };
  registerApi(app, apiDeps);

  const webDist = opts.webDist ?? resolve(import.meta.dirname, '../../webapp/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/app/', decorateReply: true, setHeaders: (reply, path) => { if (path.endsWith('.html')) reply.header('cache-control', 'no-cache'); } });
    app.get('/app', (_req, reply) => reply.redirect('/app/'));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/app/') && !req.url.includes('.')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  } else {
    app.log.warn({ webDist }, 'сборка мини-приложения не найдена – соберите webapp (npm run build -w webapp)');
  }
  app.get('/', (_req, reply) => reply.redirect('/app/'));
  return { app, db, catalog, market, apiDeps };
}
