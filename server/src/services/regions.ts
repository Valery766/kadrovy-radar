/**
 * Сравнение регионов по одной профессии: открываете точку в другом городе или
 * нанимаете вахтой – видно, где люди дешевле и где их больше.
 * Запросы идут пачками по три, ошибка одного региона не роняет остальные,
 * повторный запрос берётся из кэша вакансий.
 */
import { compareRegionMarkets, formatPct, formatRub, pluralRu, sourceNote, type Profession, type RegionComparison, type RegionMarketInput, type RegionSort } from '../core/index.js';
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
  /** true – сохранять карточку каждого региона в БД (по умолчанию нет: это служебный расчёт). */
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
    text: regionsText(req.profession.title, comparison, req.offer, fetchedAt),
    createdAt,
  };
}

/** Во сколько раз должность дешевле или дороже средней зарплаты региона, простыми словами. */
function affordabilityPhrase(index: number): string {
  const tag = `(индекс доступности ${index.toFixed(2).replace('.', ',')})`;
  if (index <= 0.67) return `Относительно средней зарплаты региона нанять дешевле в ${(1 / index).toFixed(1).replace('.', ',')} раза ${tag}.`;
  if (index < 0.95) return `Относительно средней зарплаты региона нанять дешевле на ${Math.round((1 - index) * 100)} % ${tag}.`;
  if (index <= 1.05) return `Должность стоит почти как средняя зарплата региона ${tag}.`;
  return `Должность дороже средней зарплаты региона на ${Math.round((index - 1) * 100)} % ${tag}.`;
}

/** Текст сравнения регионов для чата: детерминированный шаблон простыми словами. */
export function regionsText(professionTitle: string, comparison: RegionComparison, offer: number | null, fetchedAt: string | null = null): string {
  const rows = comparison.rows.filter((r) => r.median != null && !r.error);
  const empty = comparison.rows.filter((r) => !r.error && r.median == null);
  const failed = comparison.rows.filter((r) => r.error);
  const failedLine = failed.length ? `Не удалось посчитать: ${failed.map((r) => `${r.regionName} – ${r.error}`).join('; ')}.` : null;
  if (rows.length === 0) {
    const lines = [`По должности «${professionTitle}» ни в одном из выбранных регионов не набралось объявлений с зарплатой.`];
    if (failedLine) lines.push(failedLine);
    lines.push('', 'Что дальше: попробуйте другое название должности или другие регионы: /regions.');
    return lines.join('\n');
  }
  const lines: string[] = [`«${professionTitle}»: сравнение ${rows.length} ${pluralRu(rows.length, 'региона', 'регионов', 'регионов')}, от самого дешёвого к самому дорогому.`, ''];
  // 1. Вывод одной фразой.
  const cheapest = rows[0]!;
  const dearest = rows[rows.length - 1]!;
  const { summary } = comparison;
  if (rows.length >= 2 && summary.spreadPct != null) {
    lines.push(`Дешевле всего нанять в регионе «${cheapest.regionName}»: обычная ставка ${formatRub(cheapest.median!)}. Дороже всего – «${dearest.regionName}»: ${formatRub(dearest.median!)}, на ${formatPct(summary.spreadPct)} дороже.`);
  } else {
    lines.push(`Обычная ставка в регионе «${cheapest.regionName}» – ${formatRub(cheapest.median!)}: половина работодателей платит меньше, половина больше.`);
  }
  lines.push('');
  // 2. Числа по каждому региону.
  for (const r of rows) {
    const parts = [`${r.rank}. ${r.regionName}: обычная ставка ${formatRub(r.median!)}, половина вакансий в ${formatRub(r.p25!)}–${formatRub(r.p75!)}.`];
    parts.push(`Посчитано по ${r.vacancies} ${pluralRu(r.vacancies, 'объявлению', 'объявлениям', 'объявлениям')} ${r.employers} ${pluralRu(r.employers, 'работодателя', 'работодателей', 'работодателей')}.`);
    if (r.affordability != null) parts.push(affordabilityPhrase(r.affordability));
    if (offer != null && r.offerPercentile != null) {
      parts.push(r.offerPercentile >= 50
        ? `Ваши ${formatRub(offer)} здесь больше, чем у ${r.offerPercentile} из 100 работодателей.`
        : `Ваши ${formatRub(offer)} здесь ниже большинства: только ${r.offerPercentile} из 100 работодателей платят меньше.`);
    }
    if (r.confidence === 'low') parts.push('Данных мало, цифры – ориентир.');
    lines.push(parts.join(' '));
  }
  lines.push('');
  // 3. Что это значит для вас.
  const byCode = new Map(rows.map((r) => [r.fnsCode, r]));
  const best = summary.bestAffordability ? byCode.get(summary.bestAffordability) : undefined;
  const busiest = summary.mostVacancies ? byCode.get(summary.mostVacancies) : undefined;
  const meaning: string[] = [];
  if (best && best.fnsCode !== cheapest.fnsCode) meaning.push(`самая низкая ставка в регионе «${cheapest.regionName}», но относительно местных зарплат выгоднее нанимать в регионе «${best.regionName}»: там должность дешевле среднего по региону.`);
  else meaning.push(`регион «${cheapest.regionName}» выгоднее и по ставке, и относительно местных зарплат.`);
  if (busiest) meaning.push(`Больше всего объявлений в регионе «${busiest.regionName}»: там проще найти людей, но и конкуренция за них выше.`);
  lines.push(`Что это значит для вас: ${meaning.join(' ')}`);
  lines.push('Индекс доступности – это обычная ставка должности, делённая на среднюю зарплату региона: чем меньше, тем дешевле нанять здесь относительно местного рынка.');
  if (empty.length) lines.push(`Без данных (объявлений с зарплатой не нашлось): ${empty.map((r) => r.regionName).join(', ')}.`);
  if (failedLine) lines.push(failedLine);
  lines.push('');
  // 4. Что дальше.
  lines.push('Что дальше:');
  lines.push('1) Откройте «Регионы в приложении»: там таблица и сортировка по ставке, доступности и числу объявлений.');
  lines.push('2) Проверьте ставку в выбранном регионе подробнее: /stavka.');
  lines.push('3) Посмотрите весь рынок региона по десятку должностей: /digest.');
  lines.push('');
  // 5. Источник и дата.
  lines.push(sourceNote(fetchedAt));
  return lines.join('\n');
}
