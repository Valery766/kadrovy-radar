/**
 * Сервис рынка: связывает источники (интеграции), кэш (БД) и ядро.
 * Поток: профессия+регион → кэш/живой запрос к «Работе России» → обогащение работодателей
 * через реестр МСП → детерминированный расчёт ядра → карточка с бейджами источников.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { closureStats, getBusinessProfile, getVacancyCache, putBusinessProfile, putCard, putVacancyCache, recordVacancySeen, type ClosureStats } from '../db/index.js';
import { computeMarket, prepareVacancies, salaryValue, type MarketCard, type MspCategory, type Pack, type Profession, type VacancyRecord } from '../core/index.js';
import { rmsp, trudvsem, SOURCES, SourceError } from '../integrations/index.js';
import type { BusinessProfile } from '../integrations/rmsp.js';
import type { Config } from '../config.js';
import type { PackCatalog, RegionInfo } from '../packs/loader.js';
import { isCustomProfessionKey, regionByFnsCode, selectPack } from '../packs/loader.js';

export interface MarketContext { db: Db; config: Config; catalog: PackCatalog; log: { info: (o: object, msg?: string) => void; warn: (o: object, msg?: string) => void } }

export interface SourceBadge { id: string; title: string; url: string; fetchedAt: string; note?: string }

export interface MarketResult {
  cardId: string;
  card: MarketCard;
  pack: { id: string; title: string; version: number };
  profession: Profession;
  region: RegionInfo;
  profile: BusinessProfile | null;
  sources: SourceBadge[];
  fetched: { total: number; records: number; cacheHit: boolean; fetchedAt: string };
  closure: ClosureStats | null;
  createdAt: string;
}

export class MarketError extends Error {
  constructor(public readonly code: 'profession_unknown' | 'region_unknown' | 'source_unavailable', message: string) { super(message); this.name = 'MarketError'; }
}

const hoursAgo = (iso: string) => (Date.now() - Date.parse(iso)) / 3_600_000;

/** Профиль бизнеса по ИНН с кэшем. */
export async function getProfile(ctx: MarketContext, inn: string, opts: { forceRefresh?: boolean } = {}): Promise<BusinessProfile> {
  const cached = getBusinessProfile<BusinessProfile>(ctx.db, inn);
  if (cached && !opts.forceRefresh && hoursAgo(cached.fetchedAt) < ctx.config.profileCacheHours) return cached.payload;
  try {
    const profile = await rmsp.fetchBusinessProfile(inn);
    putBusinessProfile(ctx.db, inn, profile, profile.fetchedAt);
    return profile;
  } catch (err) {
    if (cached) { ctx.log.warn({ inn, err: String(err) }, 'rmsp недоступен, отдаём кэш'); return cached.payload; }
    // Техническая причина — только в лог: пользователю нужен понятный выход, а не «rmsp: HTTP 500».
    ctx.log.warn({ inn, err: String(err) }, 'rmsp недоступен и кэша нет');
    throw new MarketError('source_unavailable', 'Реестр МСП ФНС сейчас не отвечает. Можно продолжить без ИНН — просто укажите регион.');
  }
}

/** Вакансии по региону и запросу профессии: кэш или живой запрос. */
async function getVacancies(ctx: MarketContext, regionCode: string, profession: Profession, professionKey: string, forceRefresh: boolean): Promise<{ vacancies: VacancyRecord[]; total: number; fetchedAt: string; cacheHit: boolean }> {
  const cacheKey = `${regionCode}:${profession.query.toLowerCase()}`;
  const cached = getVacancyCache<VacancyRecord[]>(ctx.db, cacheKey);
  if (cached && !forceRefresh && hoursAgo(cached.fetchedAt) < ctx.config.vacancyCacheHours) {
    return { vacancies: cached.payload, total: cached.total, fetchedAt: cached.fetchedAt, cacheHit: true };
  }
  try {
    const res = await trudvsem.fetchVacancies({ regionCode, text: profession.query, maxRecords: ctx.config.maxVacancyRecords, concurrency: 6 });
    if (res.failedPages > 0) ctx.log.warn({ regionCode, query: profession.query, failedPages: res.failedPages, pages: res.pages }, 'trudvsem: часть страниц не загрузилась');
    if (res.failedPages === 0 || !cached) putVacancyCache(ctx.db, { cacheKey, regionCode, query: profession.query, total: res.total, payload: res.vacancies, fetchedAt: res.fetchedAt });
    if (res.failedPages === 0) recordVacancySeen(ctx.db, regionCode, professionKey, res.vacancies.map((v) => ({ id: v.id, employerInn: v.employerInn, value: salaryValue(v) })), res.fetchedAt);
    ctx.log.info({ regionCode, query: profession.query, total: res.total, records: res.vacancies.length, pages: res.pages, failedPages: res.failedPages }, 'trudvsem: выборка обновлена');
    return { vacancies: res.vacancies, total: res.total, fetchedAt: res.fetchedAt, cacheHit: false };
  } catch (err) {
    if (cached) { ctx.log.warn({ cacheKey, err: String(err) }, 'trudvsem недоступен, отдаём устаревший кэш'); return { vacancies: cached.payload, total: cached.total, fetchedAt: cached.fetchedAt, cacheHit: true }; }
    // Техническая причина («trudvsem: таймаут 15000 мс») остаётся в логе, пользователь её не видит.
    const msg = err instanceof SourceError ? err.message : String((err as Error).message ?? err);
    ctx.log.warn({ cacheKey, regionCode, query: profession.query, err: msg }, 'trudvsem недоступен и кэша нет');
    throw new MarketError('source_unavailable', 'Портал «Работа России» не ответил, попробуйте через минуту.');
  }
}

/** Обогащение работодателей (ИНН → категория МСП, ОКВЭД) с кэшем и ограничением параллелизма. */
async function enrichEmployers(ctx: MarketContext, vacancies: VacancyRecord[], limit: number): Promise<void> {
  const inns = [...new Set(vacancies.map((v) => v.employerInn).filter((x): x is string => !!x))].slice(0, limit);
  const profiles = new Map<string, BusinessProfile | null>();
  const queue = [...inns];
  const worker = async () => {
    for (let inn = queue.shift(); inn; inn = queue.shift()) {
      const cached = getBusinessProfile<BusinessProfile>(ctx.db, inn);
      if (cached && hoursAgo(cached.fetchedAt) < ctx.config.profileCacheHours) { profiles.set(inn, cached.payload); continue; }
      try {
        const p = await rmsp.fetchBusinessProfile(inn);
        putBusinessProfile(ctx.db, inn, p, p.fetchedAt);
        profiles.set(inn, p);
      } catch { profiles.set(inn, cached?.payload ?? null); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, inns.length) }, worker));
  for (const v of vacancies) {
    if (!v.employerInn || !profiles.has(v.employerInn)) continue;
    const p = profiles.get(v.employerInn);
    v.employer = p ? { inn: p.inn, name: p.name, category: p.category, okved: p.okved, okvedName: p.okvedName, fnsRegionCode: p.fnsRegionCode, kind: p.kind, registeredAt: p.registeredAt, active: p.active } : null;
  }
}

export interface MarketRequest {
  /** Ключ профессии каталога либо «custom:<slug>» для свободного ввода. */
  professionKey: string;
  /**
   * Готовое описание профессии (свободный ввод): имеет приоритет над professionKey.
   * Собирается через resolveProfession() — там же формируется ключ «custom:<slug>».
   */
  profession?: Profession | null;
  /** Код ФНС региона ("78"); если не задан — берётся из профиля. */
  regionFnsCode: string | null;
  inn: string | null;
  offer: number | null;
  maxUserId: number | null;
  forceRefresh?: boolean;
  /** false — не сохранять карточку в БД (служебные расчёты: сравнение регионов, сводки). */
  persist?: boolean;
}

/**
 * Профессия запроса: явно переданный объект → профессия пакета → каталог.
 * Ключ вида «custom:<slug>» без объекта профессии означает, что вызывающая сторона
 * потеряла текст запроса — восстановить его из ключа нельзя (это хеш).
 */
export function resolveRequestProfession(ctx: MarketContext, pack: Pack, req: Pick<MarketRequest, 'professionKey' | 'profession'>): Profession {
  if (req.profession) return req.profession;
  const found = pack.professions.find((p) => p.key === req.professionKey)
    ?? ctx.catalog.professions.find((p) => p.key === req.professionKey);
  if (found) return found;
  if (isCustomProfessionKey(req.professionKey)) {
    throw new MarketError('profession_unknown', 'Для своей должности передайте поле profession (название и текст запроса), а не только ключ');
  }
  throw new MarketError('profession_unknown', `Профессия «${req.professionKey}» не найдена в каталоге`);
}

export async function buildMarket(ctx: MarketContext, req: MarketRequest): Promise<MarketResult> {
  const profile = req.inn ? await getProfile(ctx, req.inn) : null;
  const regionFns = req.regionFnsCode ?? profile?.fnsRegionCode ?? null;
  const region = regionByFnsCode(ctx.catalog, regionFns);
  if (!region) throw new MarketError('region_unknown', 'Не удалось определить регион: укажите его вручную');
  const pack: Pack = selectPack(ctx.catalog, { fnsRegionCode: region.fnsCode, okved: profile?.okved ?? null });
  const profession = resolveRequestProfession(ctx, pack, req);

  const fetched = await getVacancies(ctx, region.code, profession, profession.key, req.forceRefresh ?? false);
  const input = {
    vacancies: fetched.vacancies, profession, regionCode: region.code, regionName: region.name,
    offer: req.offer, thresholds: pack.thresholds, requirementPhrases: pack.requirementPhrases,
    userCategory: (profile?.category ?? null) as MspCategory | null,
  };
  const { kept } = prepareVacancies(input);
  await enrichEmployers(ctx, kept, ctx.config.maxEmployersToEnrich);
  const card = computeMarket(input);
  const closure = card.stats ? closureStats(ctx.db, region.code, profession.key, card.stats.median, fetched.fetchedAt) : null;

  const cardId = randomUUID();
  const createdAt = new Date().toISOString();
  const sources: SourceBadge[] = [
    { ...SOURCES.trudvsem, fetchedAt: fetched.fetchedAt, note: `${fetched.total} вакансий по запросу «${profession.query}», загружено ${fetched.vacancies.length}` },
    { ...SOURCES.rmsp, fetchedAt: profile?.fetchedAt ?? createdAt, note: profile ? 'профиль бизнеса и категории работодателей' : 'категории работодателей' },
  ];
  const result: MarketResult = {
    cardId, card, pack: { id: pack.id, title: pack.title, version: pack.version }, profession, region, profile, sources,
    fetched: { total: fetched.total, records: fetched.vacancies.length, cacheHit: fetched.cacheHit, fetchedAt: fetched.fetchedAt }, closure, createdAt,
  };
  if (req.persist !== false) {
    putCard(ctx.db, { id: cardId, maxUserId: req.maxUserId, inn: req.inn, packId: pack.id, professionKey: profession.key, regionCode: region.code, offer: req.offer, payload: result });
  }
  return result;
}
