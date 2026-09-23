/**
 * Сравнение регионов по одной профессии – чистая часть.
 * Ядро не ходит в источники и не знает названий регионов: на вход приходят уже
 * посчитанные срезы рынка, на выходе – упорядоченная таблица с индексами.
 */
import type {
  HistogramBucket, RegionComparison, RegionComparisonRow, RegionMarketInput, RegionSort, SalaryStats,
} from './types.js';
import { percentileFromHistogram } from './stats.js';

function affordabilityIndex(stats: SalaryStats | null, avgSalary: number | null): number | null {
  if (!stats || !avgSalary || avgSalary <= 0) return null;
  // Медиана профессии к средней зарплате региона: < 1 – профессия дешевле среднего по региону.
  return Math.round((100 * stats.median) / avgSalary) / 100;
}

function offerPercentile(histogram: HistogramBucket[] | undefined, offer: number | null | undefined): number | null {
  if (offer == null || !histogram || histogram.length === 0) return null;
  return percentileFromHistogram(histogram, offer);
}

export interface CompareRegionsOptions {
  /** Ставка пользователя: для каждого региона считаем её перцентиль. */
  offer?: number | null;
  /** Чем сортировать: медианой (по возрастанию), индексом доступности или числом вакансий. */
  sortBy?: RegionSort;
}

/**
 * Упорядочивает срезы по регионам и считает производные показатели.
 * Регионы без данных (ошибка источника или пустая выборка) не выбрасываются,
 * а уходят в конец таблицы с сохранением причины.
 */
export function compareRegionMarkets(inputs: RegionMarketInput[], opts: CompareRegionsOptions = {}): RegionComparison {
  const sortBy: RegionSort = opts.sortBy ?? 'median';
  const rows: RegionComparisonRow[] = inputs.map((r) => ({
    fnsCode: r.fnsCode,
    regionCode: r.regionCode ?? null,
    regionName: r.regionName,
    avgSalary: r.avgSalary ?? null,
    median: r.stats?.median ?? null,
    p25: r.stats?.p25 ?? null,
    p75: r.stats?.p75 ?? null,
    vacancies: r.vacancies,
    employers: r.employers,
    affordability: affordabilityIndex(r.stats ?? null, r.avgSalary ?? null),
    offerPercentile: offerPercentile(r.histogram, opts.offer),
    confidence: r.confidence ?? null,
    error: r.error ?? null,
    rank: 0,
  }));

  const withData = rows.filter((r) => r.median != null && !r.error);
  const withoutData = rows.filter((r) => !(r.median != null && !r.error));
  const key = (r: RegionComparisonRow): number => {
    if (sortBy === 'affordability') return r.affordability ?? Number.POSITIVE_INFINITY;
    if (sortBy === 'vacancies') return -r.vacancies;
    return r.median ?? Number.POSITIVE_INFINITY;
  };
  withData.sort((a, b) => key(a) - key(b) || a.regionName.localeCompare(b.regionName, 'ru'));
  withData.forEach((r, i) => { r.rank = i + 1; });

  const medians = withData.map((r) => r.median!).sort((a, b) => a - b);
  return {
    sortBy,
    rows: [...withData, ...withoutData],
    summary: {
      regions: rows.length,
      withData: withData.length,
      failed: rows.filter((r) => r.error).length,
      cheapest: withData[0]?.fnsCode ?? null,
      mostVacancies: [...withData].sort((a, b) => b.vacancies - a.vacancies)[0]?.fnsCode ?? null,
      bestAffordability: [...withData]
        .filter((r) => r.affordability != null)
        .sort((a, b) => a.affordability! - b.affordability!)[0]?.fnsCode ?? null,
      medianMin: medians[0] ?? null,
      medianMax: medians[medians.length - 1] ?? null,
      /** Разрыв между самым дешёвым и самым дорогим регионом, %. */
      spreadPct: medians.length >= 2 && medians[0]! > 0
        ? Math.round((1000 * (medians[medians.length - 1]! - medians[0]!)) / medians[0]!) / 10
        : null,
    },
  };
}
