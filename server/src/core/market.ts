import type {
  CategoryStats, MarketCard, MarketInput, MspCategory, OfferOption, VacancyExample, VacancyRecord,
} from './types.js';
import { matchTitle, salaryValue } from './normalize.js';
import { dedupeVacancies } from './dedupe.js';
import { histogram, median, percentileOf, salaryStats } from './stats.js';
import { phraseStats, scheduleStats } from './requirements.js';
import { bandOf, buildVerdict } from './verdict.js';
import { roundUpThousand } from './text.js';
import { seasonality } from './seasonality.js';

export const CATEGORY_LABEL: Record<string, string> = {
  '1': 'микропредприятия',
  '2': 'малые предприятия',
  '3': 'средние предприятия',
  null: 'не МСП (бюджет, крупный бизнес)',
};

export function categoryLabel(category: MspCategory | null): string {
  if (category == null || category === 0) return CATEGORY_LABEL.null!;
  return CATEGORY_LABEL[String(category)]!;
}

interface Prepared {
  kept: VacancyRecord[];
  values: number[];
  dropped: Record<string, number>;
}

/** Фильтрация по профессии и правдоподобию зарплаты, затем дедупликация. */
export function prepareVacancies(input: MarketInput): Prepared {
  const { vacancies, profession, thresholds } = input;
  const dropped: Record<string, number> = {};
  const bump = (k: string) => { dropped[k] = (dropped[k] ?? 0) + 1; };
  const filtered: VacancyRecord[] = [];
  for (const v of vacancies) {
    const m = matchTitle(v.title, profession, v.typicalPosition);
    if (!m.matched) { bump(m.reason === 'excluded' ? 'other_role' : 'title_mismatch'); continue; }
    const value = salaryValue(v);
    if (value == null) { bump('no_salary'); continue; }
    if (value < thresholds.salaryMin || value > thresholds.salaryMax) { bump('implausible_salary'); continue; }
    filtered.push(v);
  }
  const d = dedupeVacancies(filtered, thresholds.perEmployerCap);
  if (d.duplicates) dropped.duplicates = d.duplicates;
  if (d.capped) dropped.employer_cap = d.capped;
  const values = d.kept.map((v) => salaryValue(v)!);
  return { kept: d.kept, values, dropped };
}

function uniqueEmployers(vs: VacancyRecord[]): number {
  return new Set(vs.map((v) => v.employerInn ?? `id:${v.id}`)).size;
}

function topEmployerShare(vs: VacancyRecord[]): number {
  if (vs.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const v of vs) { const k = v.employerInn ?? `id:${v.id}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
  return Math.round((100 * Math.max(...counts.values())) / vs.length);
}

function categoryStats(vs: VacancyRecord[]): CategoryStats[] {
  const groups = new Map<string, VacancyRecord[]>();
  for (const v of vs) {
    if (v.employer === undefined) continue; // обогащение не выполнялось
    const cat = v.employer?.category ?? null;
    const key = cat == null || cat === 0 ? 'null' : String(cat);
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  const order = ['1', '2', '3', 'null'];
  return order
    .filter((k) => groups.has(k))
    .map((k) => {
      const list = groups.get(k)!;
      const category = k === 'null' ? null : (Number(k) as MspCategory);
      return {
        category,
        label: categoryLabel(category),
        employers: uniqueEmployers(list),
        vacancies: list.length,
        median: list.length ? Math.round(median(list.map((v) => salaryValue(v)!))) : null,
      };
    });
}

function pickExamples(vs: VacancyRecord[], center: number, limit = 5): VacancyExample[] {
  // Пять вакансий от разных работодателей, ближайшие к медиане: показывают «типичное» предложение.
  const seen = new Set<string>();
  const sorted = [...vs].sort((a, b) => Math.abs(salaryValue(a)! - center) - Math.abs(salaryValue(b)! - center));
  const out: VacancyExample[] = [];
  for (const v of sorted) {
    const key = v.employerInn ?? `id:${v.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: v.id,
      title: v.title,
      employerName: v.employerName,
      employerInn: v.employerInn,
      employerCategory: v.employer === undefined ? undefined : (v.employer?.category ?? null),
      salaryMin: v.salaryMin,
      salaryMax: v.salaryMax,
      value: Math.round(salaryValue(v)!),
      schedule: v.schedule,
      url: v.url,
    });
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => b.value - a.value);
}

function buildOptions(values: number[], offer: number | null, p50: number, p75: number): OfferOption[] {
  const opts: OfferOption[] = [];
  if (offer != null) {
    opts.push({ kind: 'keep', value: offer, percentile: percentileOf(values, offer), label: 'Оставить как есть' });
  }
  const m = roundUpThousand(p50 + 1);
  const t = Math.max(roundUpThousand(p75 + 1), m + 1000);
  if (offer == null || offer < m) opts.push({ kind: 'median', value: m, percentile: percentileOf(values, m), label: 'Выйти на медиану' });
  if (offer == null || offer < t) opts.push({ kind: 'top', value: t, percentile: percentileOf(values, t), label: 'В верхнюю четверть' });
  return opts;
}

/** Главная функция ядра: из сырых вакансий и ставки — карточка рынка с вердиктом. */
export function computeMarket(input: MarketInput): MarketCard {
  const { profession, thresholds, regionCode, regionName, userCategory } = input;
  const now = input.now ?? new Date();
  const { kept, values, dropped } = prepareVacancies(input);
  const employers = uniqueEmployers(kept);
  const stats = salaryStats(values);

  let confidence: MarketCard['confidence'] = 'ok';
  let confidenceReason: string | null = null;
  if (!stats || kept.length === 0) {
    confidence = 'none';
    confidenceReason = 'Нет подходящих вакансий с зарплатой';
  } else if (employers < thresholds.minEmployers || kept.length < thresholds.minVacancies) {
    confidence = 'low';
    confidenceReason = `Мало данных: ${kept.length} вакансий, ${employers} работодателей (нужно ≥ ${thresholds.minVacancies} и ≥ ${thresholds.minEmployers})`;
  }

  const fixedShare = kept.length
    ? Math.round((100 * kept.filter((v) => v.salaryMin != null && v.salaryMax != null && v.salaryMin === v.salaryMax).length) / kept.length)
    : null;

  const monthAgo = new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
  const recent = kept.filter((v) => v.createdAt && v.createdAt >= monthAgo).map((v) => salaryValue(v)!);
  const recentMedian = recent.length >= 5 ? Math.round(median(recent)) : null;

  const byCategory = categoryStats(kept);
  const sameSize = userCategory != null && userCategory !== 0
    ? byCategory.find((c) => c.category === userCategory) ?? null
    : null;

  const offer = input.offer != null && stats
    ? (() => {
      const percentile = percentileOf(values, input.offer!);
      const above = values.filter((v) => v > input.offer!).length;
      return {
        value: input.offer!,
        percentile,
        band: bandOf(percentile),
        shareAbove: Math.round((100 * above) / values.length),
      };
    })()
    : null;

  const base: Omit<MarketCard, 'verdict'> = {
    professionKey: profession.key,
    professionTitle: profession.title,
    regionCode,
    sample: { fetched: input.vacancies.length, vacancies: kept.length, employers, topEmployerShare: topEmployerShare(kept), dropped },
    confidence,
    confidenceReason,
    stats,
    fixedShare,
    recentMedian,
    offer,
    options: stats ? buildOptions(values, input.offer, stats.median, stats.p75) : [],
    histogram: histogram(values),
    byCategory,
    sameSize,
    examples: stats ? pickExamples(kept, stats.median) : [],
    requirements: phraseStats(kept, input.requirementPhrases),
    schedules: scheduleStats(kept),
    seasonality: seasonality(kept),
  };
  return { ...base, verdict: buildVerdict(base, profession.title, regionName) };
}
