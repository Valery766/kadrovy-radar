/**
 * Региональная сводка для партнёров (центр «Мой бизнес», центр занятости,
 * отраслевая ассоциация, банк для МСП): таблица медиан и выборок по профессиям региона
 * плюс готовый текст, который бот отправляет в чат или публикует в канал.
 */
import { formatDateRu, formatRub, pluralRu, sourceNote, type Confidence, type Profession, type Seasonality } from '../core/index.js';
import { regionByFnsCode, type RegionInfo } from '../packs/loader.js';
import { SOURCES } from '../integrations/index.js';
import { buildMarket, MarketError, type MarketContext, type SourceBadge } from './market.js';
import { mapLimit } from './pool.js';

/** Не больше трёх профессий одновременно – лимиты источника. */
const DIGEST_CONCURRENCY = 3;

/** Верхняя граница на одну сводку. */
export const MAX_DIGEST_PROFESSIONS = 12;

export interface RegionDigestRow {
  professionKey: string;
  professionTitle: string;
  median: number | null;
  p25: number | null;
  p75: number | null;
  /** Медиана по вакансиям последних 30 дней, если их хватает. */
  recentMedian: number | null;
  vacancies: number;
  employers: number;
  /** Сколько записей отдал источник по запросу профессии (спрос по региону). */
  total: number;
  confidence: Confidence | null;
  /** Медиана среди микропредприятий региона – ориентир для малого бизнеса. */
  microMedian: number | null;
  /** Неделя пика набора по датам публикации, если распределение посчиталось. */
  peakWeek: Seasonality['peak'];
  error: string | null;
}

export interface RegionDigestResult {
  region: RegionInfo;
  rows: RegionDigestRow[];
  /** Средняя зарплата региона из справочника – знаменатель индекса доступности. */
  avgSalary: number | null;
  sources: SourceBadge[];
  /** Готовый текст сводки (детерминированный шаблон, по-русски). */
  text: string;
  createdAt: string;
}

export interface RegionDigestOptions {
  forceRefresh?: boolean;
  /** true – сохранять карточки в БД (по умолчанию нет: сводка служебная). */
  persist?: boolean;
  /** Дата для подписи сводки; по умолчанию – текущая. */
  now?: Date;
}

/**
 * Сводка по региону: по каждому ключу профессии считается рынок (кэш или живой запрос),
 * ошибки по отдельной профессии не роняют остальные строки.
 */
export async function regionDigest(ctx: MarketContext, fnsCode: string, professionKeys: string[], opts: RegionDigestOptions = {}): Promise<RegionDigestResult> {
  const region = regionByFnsCode(ctx.catalog, fnsCode);
  if (!region) throw new MarketError('region_unknown', `Регион с кодом ФНС ${fnsCode} не найден в справочнике`);
  const keys = [...new Set(professionKeys.map((k) => k.trim()).filter(Boolean))].slice(0, MAX_DIGEST_PROFESSIONS);
  if (keys.length === 0) throw new MarketError('profession_unknown', 'Не указана ни одна профессия для сводки');

  const professions: { key: string; profession: Profession | null }[] = keys.map((key) => ({
    key,
    profession: ctx.catalog.professions.find((p) => p.key === key)
      ?? ctx.catalog.packs.flatMap((p) => p.professions).find((p) => p.key === key)
      ?? null,
  }));

  const settled = await mapLimit(professions, DIGEST_CONCURRENCY, async (p) => {
    if (!p.profession) throw new MarketError('profession_unknown', `Профессия «${p.key}» не найдена в каталоге`);
    return buildMarket(ctx, {
      professionKey: p.profession.key,
      profession: p.profession,
      regionFnsCode: region.fnsCode,
      inn: null,
      offer: null,
      maxUserId: null,
      forceRefresh: opts.forceRefresh ?? false,
      persist: opts.persist ?? false,
    });
  });

  let fetchedAt: string | null = null;
  const rows: RegionDigestRow[] = professions.map((p, i) => {
    const res = settled[i]!;
    if (!res.ok) {
      ctx.log.warn({ professionKey: p.key, fnsCode, err: res.error.message }, 'сводка региона: профессия не посчитана');
      return {
        professionKey: p.key, professionTitle: p.profession?.title ?? p.key,
        median: null, p25: null, p75: null, recentMedian: null,
        vacancies: 0, employers: 0, total: 0, confidence: null, microMedian: null, peakWeek: null,
        error: res.error.message,
      };
    }
    const { card, fetched } = res.value;
    fetchedAt = fetchedAt ?? fetched.fetchedAt;
    return {
      professionKey: card.professionKey,
      professionTitle: card.professionTitle,
      median: card.stats?.median ?? null,
      p25: card.stats?.p25 ?? null,
      p75: card.stats?.p75 ?? null,
      recentMedian: card.recentMedian,
      vacancies: card.sample.vacancies,
      employers: card.sample.employers,
      total: fetched.total,
      confidence: card.confidence,
      microMedian: card.byCategory.find((c) => c.category === 1)?.median ?? null,
      peakWeek: card.seasonality?.peak ?? null,
      error: null,
    };
  });

  // Сортировка сводки: сначала самые массовые профессии региона.
  rows.sort((a, b) => b.total - a.total || a.professionTitle.localeCompare(b.professionTitle, 'ru'));

  const createdAt = (opts.now ?? new Date()).toISOString();
  return {
    region,
    rows,
    avgSalary: region.avgSalary,
    sources: [{ ...SOURCES.trudvsem, fetchedAt: fetchedAt ?? createdAt, note: `${rows.filter((r) => !r.error).length} из ${rows.length} профессий с данными` }],
    text: digestText(region, rows, opts.now ?? new Date(), fetchedAt),
    createdAt,
  };
}

const two = (n: number) => String(n).padStart(2, '0');

/** Обычная ставка должности относительно средней зарплаты региона, простыми словами. */
function ratioPhrase(median: number, avgSalary: number): string {
  const x = median / avgSalary;
  const pct = Math.round(100 * x);
  if (x <= 0.67) return `дешевле средней зарплаты региона в ${(1 / x).toFixed(1).replace('.', ',')} раза (${pct} % от средней)`;
  if (x < 0.95) return `дешевле средней зарплаты региона (${pct} % от средней)`;
  if (x <= 1.05) return `почти как средняя зарплата региона (${pct} % от средней)`;
  return `дороже средней зарплаты региона (${pct} % от средней)`;
}

/** Текст сводки для отправки ботом или публикации в канал. Никакой генерации: шаблон и числа. */
export function digestText(region: RegionInfo, rows: RegionDigestRow[], now: Date, fetchedAt: string | null = null): string {
  const date = `${two(now.getDate())}.${two(now.getMonth() + 1)}.${now.getFullYear()}`;
  const ok = rows.filter((r) => r.median != null && !r.error);
  const lines: string[] = [`📍 Рынок труда региона: ${region.name}, ${date}`];
  if (region.avgSalary) lines.push(`Средняя зарплата по региону – ${formatRub(region.avgSalary)} (справочник «Работы России»): с ней сравниваю каждую должность.`);
  if (ok.length === 0) {
    lines.push('По выбранным должностям объявлений с зарплатой в регионе не нашлось.');
    lines.push('');
    lines.push('Что дальше: проверьте одну должность отдельно (/stavka) или сравните регионы (/regions).');
    return lines.join('\n');
  }
  lines.push('');
  // 1. Вывод одной фразой.
  const top = [...ok].sort((a, b) => b.total - a.total)[0]!;
  const expensive = [...ok].sort((a, b) => b.median! - a.median!)[0]!;
  lines.push(`Больше всего ищут «${top.professionTitle}»: ${top.total} ${pluralRu(top.total, 'объявление', 'объявления', 'объявлений')} по региону. Дороже всего обходится «${expensive.professionTitle}»: обычная ставка ${formatRub(expensive.median!)}.`);
  lines.push('');
  // 2. Числа по каждой должности.
  lines.push('По должностям, сначала самые массовые:');
  for (const r of ok) {
    const parts = [`• ${r.professionTitle}: обычная ставка ${formatRub(r.median!)} (медиана), половина вакансий в ${formatRub(r.p25!)}–${formatRub(r.p75!)}.`];
    parts.push(`Посчитано по ${r.vacancies} ${pluralRu(r.vacancies, 'объявлению', 'объявлениям', 'объявлениям')} ${r.employers} ${pluralRu(r.employers, 'работодателя', 'работодателей', 'работодателей')}, всего нашлось ${r.total}.`);
    if (r.microMedian != null) parts.push(`Микропредприятия (до 15 сотрудников) платят ${formatRub(r.microMedian)}.`);
    if (r.recentMedian != null) parts.push(`По объявлениям последних 30 дней обычная ставка ${formatRub(r.recentMedian)}.`);
    if (r.confidence === 'low') parts.push('Данных мало, цифры – ориентир.');
    lines.push(parts.join(' '));
  }
  lines.push('');
  // 3. Что это значит для вас.
  if (region.avgSalary) {
    const cheap = [...ok].sort((a, b) => a.median! - b.median!)[0]!;
    lines.push(`Что это значит для вас: «${cheap.professionTitle}» обходится ${ratioPhrase(cheap.median!, region.avgSalary)}, «${expensive.professionTitle}» – ${ratioPhrase(expensive.median!, region.avgSalary)}.`);
  } else {
    lines.push('Что это значит для вас: ориентир для найма – обычная ставка по каждой должности. Половина работодателей платит меньше неё, половина больше.');
  }
  const peak = ok.find((r) => r.peakWeek);
  if (peak?.peakWeek) lines.push(`Чаще всего «${peak.professionTitle}» ищут в неделю ${formatDateRu(peak.peakWeek.from)} – ${formatDateRu(peak.peakWeek.to)}: в пик конкуренция за людей выше, начинайте набор заранее.`);
  const failed = rows.filter((r) => r.error);
  if (failed.length) lines.push(`Не удалось посчитать: ${failed.map((r) => r.professionTitle).join(', ')}.`);
  lines.push('');
  // 4. Что дальше.
  lines.push('Что дальше:');
  lines.push('1) Проверьте свою ставку по одной должности: /stavka.');
  lines.push('2) Сравните эту же должность в других регионах: /regions.');
  lines.push('3) Откройте приложение: там таблица и графики по всем должностям.');
  lines.push('');
  // 5. Источник и дата.
  lines.push(sourceNote(fetchedAt));
  return lines.join('\n');
}
