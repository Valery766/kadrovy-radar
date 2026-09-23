/**
 * HTTP API мини-приложения. Авторизация: сессия, выданная после проверки initData (HMAC).
 * Вне MAX доступен демо-режим (публичные данные, без отправки в чат).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { deactivateSubscription, getCard, getMeta, getUser, listCardsByUser, listUserSubscriptions, updateUser, upsertSubscription, upsertUser } from '../db/index.js';
import { buildMarket, getProfile, MarketError, type MarketContext, type MarketResult } from '../services/market.js';
import { sendReportToChat, type ReportContext } from '../services/report.js';
import { buildVacancyDraft } from '../core/index.js';
import { isValidInn } from '../integrations/rmsp.js';
import { regionByFnsCode, selectPack, type PackCatalog } from '../packs/loader.js';
import { signSession, validateInitData, verifySession, type SessionPayload } from './auth.js';
import type { Config } from '../config.js';

export interface ApiDeps {
  db: Db;
  config: Config;
  catalog: PackCatalog;
  market: MarketContext;
  report: ReportContext | null;
  bot: { username: string; userId: number } | null;
  startedAt: number;
}

const DEMO_UID_BASE = -1_000_000;

function clientSummary(r: MarketResult) {
  return r; // карточка уже сериализуема; при необходимости здесь режем поля
}

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { db, config, catalog } = deps;
  const botLink = deps.bot ? `https://max.ru/${deps.bot.username}` : null;

  const auth = (req: FastifyRequest, reply: FastifyReply): SessionPayload | null => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const s = verifySession(config.sessionSecret, token);
    if (!s) { void reply.code(401).send({ error: 'unauthorized', message: 'Сессия не найдена или истекла: откройте приложение заново' }); return null; }
    return s;
  };

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof MarketError) return reply.code(err.code === 'source_unavailable' ? 503 : 400).send({ error: err.code, message: err.message });
    app.log.error({ err: String(err) }, 'api error');
    return reply.code(500).send({ error: 'internal', message: 'Внутренняя ошибка. Попробуйте ещё раз.' });
  };

  app.get('/api/health', async () => ({
    ok: true,
    uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
    updatesMode: config.updatesMode,
    bot: deps.bot ? { username: deps.bot.username } : null,
    lastUpdateAt: getMeta(db, 'last_update_at'),
    webhookCheckedAt: getMeta(db, 'webhook_checked_at'),
    packs: catalog.packs.map((p) => p.id),
  }));

  /** Сессия: initData из MAX Bridge → проверка подписи → токен. Без initData — демо-режим. */
  app.post<{ Body: { initData?: string; demo?: boolean } }>('/api/session', async (req, reply) => {
    const { initData } = req.body ?? {};
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    if (initData && config.botToken) {
      const r = validateInitData(initData, config.botToken);
      if (!r.ok) return reply.code(401).send({ error: 'init_data_invalid', reason: r.reason, message: 'Данные запуска не прошли проверку подписи. Откройте приложение из чата с ботом.' });
      const uid = r.data.user?.id;
      if (!uid) return reply.code(401).send({ error: 'init_data_invalid', reason: 'no_user', message: 'В данных запуска нет пользователя' });
      const chatId = r.data.chat?.type === 'DIALOG' ? r.data.chat.id : null;
      const u = upsertUser(db, { maxUserId: uid, name: r.data.user?.first_name ?? null, username: r.data.user?.username ?? null, chatId });
      const payload: SessionPayload = { uid, name: u.name, chatId: u.chatId, demo: false, exp };
      return { token: signSession(config.sessionSecret, payload), user: { id: uid, name: u.name, demo: false, chatId: u.chatId }, startParam: r.data.startParam };
    }
    if (initData && !config.botToken) return reply.code(503).send({ error: 'no_bot_token', message: 'Сервер запущен без токена бота — проверка initData невозможна' });
    const uid = DEMO_UID_BASE - Math.floor(Math.random() * 1_000_000);
    const payload: SessionPayload = { uid, name: null, chatId: null, demo: true, exp };
    return { token: signSession(config.sessionSecret, payload), user: { id: uid, name: null, demo: true, chatId: null }, startParam: null };
  });

  /** Всё, что нужно приложению на старте: пакеты, регионы, профессии, состояние пользователя. */
  app.get('/api/bootstrap', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const u = s.demo ? null : getUser(db, s.uid);
    const profile = u?.inn ? await getProfile(deps.market, u.inn).catch(() => null) : null;
    const pack = selectPack(catalog, { fnsRegionCode: u?.regionFnsCode ?? profile?.fnsRegionCode ?? null, okved: profile?.okved ?? null });
    return {
      bot: deps.bot ? { username: deps.bot.username, link: botLink } : null,
      packs: catalog.packs.map((p) => ({ id: p.id, title: p.title, version: p.version, region: p.region, industry: p.industry, professions: p.professions.map((x) => ({ key: x.key, title: x.title })), demo: p.demo })),
      regions: catalog.regions.map((r) => ({ fnsCode: r.fnsCode, code: r.code, name: r.name, avgSalary: r.avgSalary })),
      professions: catalog.professions.map((x) => ({ key: x.key, title: x.title })),
      user: { id: s.uid, name: s.name, demo: s.demo, chatId: s.chatId, inn: u?.inn ?? null, regionFnsCode: u?.regionFnsCode ?? profile?.fnsRegionCode ?? null, profile, pack: { id: pack.id, title: pack.title } },
      recentCards: s.demo ? [] : listCardsByUser<MarketResult>(db, s.uid, 5).map((c) => ({ id: c.id, professionKey: c.professionKey, professionTitle: c.payload.profession.title, regionName: c.payload.region.name, offer: c.offer, median: c.payload.card.stats?.median ?? null, createdAt: c.createdAt })),
      sources: [
        { id: 'trudvsem', title: '«Работа России» (Роструд)', url: 'https://trudvsem.ru/opendata/api', kind: 'live' },
        { id: 'rmsp', title: 'Единый реестр субъектов МСП (ФНС России)', url: 'https://rmsp.nalog.ru/', kind: 'live' },
      ],
    };
  });

  app.post<{ Body: { inn?: string } }>('/api/profile', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const inn = String(req.body?.inn ?? '').replace(/\D/g, '');
    if (!isValidInn(inn)) return reply.code(400).send({ error: 'inn_invalid', message: 'ИНН должен содержать 10 или 12 цифр с верной контрольной суммой' });
    try {
      const profile = await getProfile(deps.market, inn);
      const region = regionByFnsCode(catalog, profile.fnsRegionCode);
      const pack = selectPack(catalog, { fnsRegionCode: profile.fnsRegionCode, okved: profile.okved });
      if (!s.demo) updateUser(db, s.uid, { inn, regionFnsCode: profile.fnsRegionCode ?? undefined, packId: pack.id });
      return { profile, region, pack: { id: pack.id, title: pack.title, professions: pack.professions.map((x) => ({ key: x.key, title: x.title })) } };
    } catch (err) { return fail(reply, err); }
  });

  app.post<{ Body: { inn?: string | null; regionFnsCode?: string | null; professionKey?: string; offer?: number | null; forceRefresh?: boolean } }>('/api/market', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const b = req.body ?? {};
    const professionKey = String(b.professionKey ?? '');
    if (!professionKey) return reply.code(400).send({ error: 'profession_required', message: 'Укажите должность' });
    const offer = b.offer == null || b.offer === 0 ? null : Number(b.offer);
    if (offer != null && (!Number.isFinite(offer) || offer < 1000 || offer > 5_000_000)) return reply.code(400).send({ error: 'offer_invalid', message: 'Ставка должна быть от 1 000 до 5 000 000 ₽ в месяц' });
    const inn = b.inn ? String(b.inn).replace(/\D/g, '') : null;
    if (inn && !isValidInn(inn)) return reply.code(400).send({ error: 'inn_invalid', message: 'Некорректный ИНН' });
    try {
      const result = await buildMarket(deps.market, { professionKey, regionFnsCode: b.regionFnsCode ?? null, inn, offer, maxUserId: s.demo ? null : s.uid, forceRefresh: Boolean(b.forceRefresh) && !s.demo });
      if (!s.demo) updateUser(db, s.uid, { inn: inn ?? undefined, regionFnsCode: result.region.fnsCode, packId: result.pack.id, state: { step: 'idle', professionKey, lastCardId: result.cardId } });
      return clientSummary(result);
    } catch (err) { return fail(reply, err); }
  });

  app.get<{ Params: { id: string } }>('/api/cards/:id', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const row = getCard<MarketResult>(db, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'Карточка не найдена' });
    return clientSummary(row.payload);
  });

  /** Отчёт в чат: PDF → бот отправляет в диалог → mid для shareMaxContent. */
  app.post<{ Params: { id: string } }>('/api/cards/:id/report', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    if (s.demo || !deps.report) return reply.code(400).send({ error: 'demo', message: 'Отправка отчёта в чат доступна только внутри MAX. Откройте приложение из чата с ботом.' });
    const row = getCard<MarketResult>(db, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'Карточка не найдена' });
    const u = getUser(db, s.uid);
    const chatId = s.chatId ?? u?.chatId ?? null;
    if (!chatId) return reply.code(400).send({ error: 'no_chat', message: 'Не знаю ваш чат с ботом: напишите боту /start и повторите.' });
    try {
      const r = await sendReportToChat(deps.report, row.payload, s.uid, chatId);
      return { mid: r.mid, chatType: 'DIALOG', reused: r.reused };
    } catch (err) { return fail(reply, err); }
  });

  app.post<{ Params: { id: string } }>('/api/cards/:id/subscribe', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    if (s.demo) return reply.code(400).send({ error: 'demo', message: 'Подписка доступна только внутри MAX' });
    const row = getCard<MarketResult>(db, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'Карточка не найдена' });
    const u = getUser(db, s.uid);
    const chatId = s.chatId ?? u?.chatId ?? null;
    if (!chatId) return reply.code(400).send({ error: 'no_chat', message: 'Напишите боту /start, чтобы он мог присылать уведомления.' });
    const r = row.payload;
    const sub = upsertSubscription(db, { id: randomUUID(), maxUserId: s.uid, chatId, packId: r.pack.id, professionKey: r.profession.key, regionCode: r.region.code, offer: r.card.offer?.value ?? null, lastMedian: r.card.stats?.median ?? null });
    return { subscription: sub };
  });

  app.get('/api/subscriptions', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    return { subscriptions: s.demo ? [] : listUserSubscriptions(db, s.uid).map((x) => ({ ...x, professionTitle: catalog.professions.find((p) => p.key === x.professionKey)?.title ?? x.professionKey, regionName: catalog.regions.find((r) => r.code === x.regionCode)?.name ?? x.regionCode })) };
  });

  app.delete<{ Params: { id: string } }>('/api/subscriptions/:id', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    return { ok: !s.demo && deactivateSubscription(db, req.params.id, s.uid) };
  });

  app.post<{ Params: { id: string }; Body: { salary?: number } }>('/api/cards/:id/vacancy-text', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const row = getCard<MarketResult>(db, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'Карточка не найдена' });
    const r = row.payload;
    const pack = catalog.packs.find((p) => p.id === r.pack.id) ?? catalog.packs.find((p) => p.region === null)!;
    const salary = Number(req.body?.salary) || r.card.options.find((o) => o.kind === 'median')?.value || r.card.offer?.value || r.card.stats?.median || 0;
    return { text: buildVacancyDraft({ card: r.card, profession: r.profession, pack, salary, companyName: r.profile?.name ?? null, cityName: r.region.name }), salary };
  });
}
