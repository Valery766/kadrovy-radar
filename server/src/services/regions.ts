/**
 * Сравнение регионов по одной профессии: открываете точку в другом городе или
 * нанимаете вахтой — видно, где люди дешевле и где их больше.
 * Запросы идут пачками по три, ошибка одного региона не роняет остальные,
 * повторный запрос берётся из кэша вакансий.
 */
import { compareRegionMarkets, formatRub, pluralRu, type Profession, type RegionComparison, type RegionMarketInput, type RegionSort } from '../core/index.js';
import { regionByFnsCode, type RegionInfo } from '../packs/loader.js';
import { SOURCES } from '../integrations/index.js';
import { buildMarket, MarketError, type MarketContext, type SourceBadge } from './market.js';
import { mapLimit } from './pool.js';

/** Не больше трёх регионов одновременно, чтобы не превысить лимиты источника. */
const REGION_CONCURRENCY = 3;

/** Верхняя граница на один запрос: дальше сравнение перестаёт читаться и бьёт по источнику. */
export const MAX_REGIONS = 8;

export interface CompareRegionsRequest {
  /** Профессия каталога или свободного ввода (resolveProfession). */
  profession: Profession;
  /** Коды ФНС регионов («78», «23», …). */
  regionFnsCodes: string[];
  /** Ставка пользователя: считаем её перцентиль в каждом регионе. */
  offer: number | null;
  sortBy?: RegionSort;
  maxUserId?: number | null;
  inn?: string | null;
  forceRefresh?: boolean;
  /** true — сохранять карточку каждого региона в БД (по умолчанию нет: это служебный расчёт). */
  persist?: boolean;
}

export interface CompareRegionsResult {
  profession: { key: string; title: string; query: string };
  comparison: RegionComparison;
  /** Идентификаторы сохранённых карточек по коду ФНС (если persist = true). */
  cardIds: Record<string, string>;
  sources: SourceBadge[];
  /** Детерминированный текст для чата. */
  text: string;
  createdAt: string;
}

export async function compareRegions(ctx: MarketContext, req: CompareRegionsRequest): Promise<CompareRegionsResult> {
  const codes = [...new Set(req.regionFnsCodes.map((c) => c.trim()).filter(Boolean))].slice(0, MAX_REGIONS);
  if (codes.length === 0) throw new MarketError('region_unknown', 'Не указан ни один регион для сравнения');
  const regions: { fnsCode: string; info: RegionInfo | null }[] = codes.map((fnsCode) => ({ fnsCode, info: regionByFnsCode(ctx.catalog, fnsCode) }));

  const settled = await mapLimit(regions, REGION_CONCURRENCY, async (r) => {
    if (!r.info) throw new MarketError('region_unknown', `Регион с кодом ФНС ${r.fnsCode} не найден в справочнике`);
    return buildMarket(ctx, {
      professionKey: req.profession.key,
      profession: req.profession,
      regionFnsCode: r.fnsCode,
      inn: req.inn ?? null,
      offer: req.offer,
      maxUserId: req.maxUserId ?? null,
      forceRefresh: req.forceRefresh ?? false,
      persist: req.persist ?? false,
    });
  });

  const cardIds: Record<string, string> = {};
  let fetchedAt: string | null = null;
  const inputs: RegionMarketInput[] = regions.map((r, i) => {
    const res = settled[i]!;
    if (!res.ok) {
      ctx.log.warn({ fnsCode: r.fnsCode, professionKey: req.profession.key, err: res.error.message }, 'сравнение регионов: регион не посчитан');
      return {
        fnsCode: r.fnsCode,
        regionCode: r.info?.code ?? null,
        regionName: r.info?.name ?? r.fnsCode,
        avgSalary: r.info?.avgSalary ?? null,
        stats: null, vacancies: 0, employers: 0, error: res.error.message,
      };
    }
    const { card, region, cardId, fetched } = res.value;
    if (req.persist) cardIds[r.fnsCode] = cardId;
    fetchedAt = fetchedAt ?? fetched.fetchedAt;
    return {
      fnsCode: region.fnsCode,
      regionCode: region.code,
      regionName: region.name,
      avgSalary: region.avgSalary,
      stats: card.stats,
      histogram: card.histogram,
      vacancies: card.sample.vacancies,
      employers: card.sample.employers,
      confidence: card.confidence,
      error: null,
    };
  });

  const comparison = compareRegionMarkets(inputs, { offer: req.offer, sortBy: req.sortBy ?? 'median' });
  const createdAt = new Date().toISOString();
  return {
    profession: { key: req.profession.key, title: req.profession.title, query: req.profession.query },
    comparison,
    cardIds,
    sources: [{ ...SOURCES.trudvsem, fetchedAt: fetchedAt ?? createdAt, note: `${comparison.summary.withData} из ${comparison.summary.regions} регионов с данными` }],
    text: regionsText(req.profession.title, comparison, req.offer),
    createdAt,
  };
}

/** Текст сравнения регионов для чата: детерминированный шаблон. */
export function regionsText(professionTitle: string, comparison: RegionComparison, offer: number | null): string {
  const rows = comparison.rows.filter((r) => r.median != null && !r.error);
  if (rows.length === 0) return `По профессии «${professionTitle}» ни в одном из выбранных регионов не набралось вакансий с зарплатой.`;
  const lines: string[] = [`«${professionTitle}» — сравнение ${rows.length} ${pluralRu(rows.length, 'региона', 'регионов', 'регионов')} (по возрастанию медианы):`];
  for (const r of rows) {
    const parts = [`${r.rank}. ${r.regionName}: медиана ${formatRub(r.median!)}, половина предложений ${formatRub(r.p25!)}–${formatRub(r.p75!)}`];
    parts.push(`${r.vacancies} ${pluralRu(r.vacancies, 'вакансия', 'вакансии', 'вакансий')} от ${r.employers} ${pluralRu(r.employers, 'работодателя', 'работодателей', 'работодателей')}`);
    if (r.affordability != null) parts.push(`индекс доступности ${r.affordability.toFixed(2)}`);
    if (offer != null && r.offerPercentile != null) parts.push(`ваши ${formatRub(offer)} — ${r.offerPercentile}-й перцентиль`);
    lines.push(parts.join('; ') + '.');
  }
  if (comparison.summary.spreadPct != null && comparison.summary.medianMin != null && comparison.summary.medianMax != null) {
    lines.push(`Разрыв между крайними регионами — ${comparison.summary.spreadPct} % (${formatRub(comparison.summary.medianMin)} против ${formatRub(comparison.summary.medianMax)}).`);
  }
  lines.push('Индекс доступности — медиана профессии, делённая на среднюю зарплату региона: чем меньше, тем дешевле профессия относительно местного рынка труда.');
  const empty = comparison.rows.filter((r) => !r.error && r.median == null);
  if (empty.length) lines.push(`Без данных (вакансий с зарплатой не нашлось): ${empty.map((r) => r.regionName).join(', ')}.`);
  const failed = comparison.rows.filter((r) => r.error);
  if (failed.length) lines.push(`Не удалось посчитать: ${failed.map((r) => `${r.regionName} — ${r.error}`).join('; ')}.`);
  return lines.join('\n');
}
