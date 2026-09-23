/**
 * Сезонность найма: распределение вакансий по неделям публикации и «неделя пика набора».
 * Чистая функция ядра: работает с датами создания объявлений (creation-date) и ничего
 * не знает ни об отраслях, ни о регионах.
 *
 * Окно наблюдения – последние maxWeeks недель до самой свежей вакансии выборки.
 * Недели без вакансий не выбрасываются, а показываются нулями: иначе «пик» не с чем сравнить.
 */
import type { Seasonality, SeasonalityMonth, SeasonalityWeek, VacancyRecord } from './types.js';

const DAY = 86_400_000;
const MONTH_NAMES = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

/** Дата из строки источника: «2026-04-13» или ISO с временем. null – дату разобрать не удалось. */
function parseDay(value: string | null): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Понедельник недели, к которой относится дата (ISO-8601: неделя начинается с понедельника). */
export function weekStart(d: Date): Date {
  const shift = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - shift * DAY);
}

/** Номер недели по ISO-8601 в формате «2026-W15». */
export function isoWeekLabel(d: Date): string {
  const monday = weekStart(d);
  // Четверг той же недели задаёт год по ISO-8601.
  const thursday = new Date(monday.getTime() + 3 * DAY);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = Math.round((monday.getTime() - weekStart(firstThursday).getTime()) / (7 * DAY)) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export interface SeasonalityOptions {
  /** Сколько вакансий с датой нужно в окне, чтобы распределение имело смысл. */
  minDated?: number;
  /** Длина окна наблюдения в неделях (по умолчанию год). */
  maxWeeks?: number;
}

/**
 * Распределение вакансий по неделям создания за доступный период.
 * Возвращает null, если дат в окне слишком мало для вывода (по умолчанию < 20).
 */
export function seasonality(vacancies: VacancyRecord[], opts: SeasonalityOptions = {}): Seasonality | null {
  const minDated = opts.minDated ?? 20;
  const maxWeeks = Math.max(1, opts.maxWeeks ?? 53);
  const days: Date[] = [];
  for (const v of vacancies) {
    const d = parseDay(v.createdAt);
    if (d) days.push(d);
  }
  if (days.length === 0) return null;

  const lastMonday = weekStart(days.reduce((a, b) => (a > b ? a : b)));
  const firstMonday = new Date(lastMonday.getTime() - (maxWeeks - 1) * 7 * DAY);
  const inWindow = days.filter((d) => d.getTime() >= firstMonday.getTime());
  if (inWindow.length < minDated) return null;

  const byWeek = new Map<number, number>();
  const byMonth = new Map<string, number>();
  for (const d of inWindow) {
    const wk = weekStart(d).getTime();
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + 1);
    const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    byMonth.set(mk, (byMonth.get(mk) ?? 0) + 1);
  }

  const dated = inWindow.length;
  const weeks: SeasonalityWeek[] = [];
  for (let t = firstMonday.getTime(); t <= lastMonday.getTime(); t += 7 * DAY) {
    const from = new Date(t);
    const count = byWeek.get(t) ?? 0;
    weeks.push({
      week: isoWeekLabel(from),
      from: iso(from),
      to: iso(new Date(t + 6 * DAY)),
      count,
      share: Math.round((1000 * count) / dated) / 10,
    });
  }

  const months: SeasonalityMonth[] = [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, count]) => ({
      month: key,
      label: `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]!} ${key.slice(0, 4)}`,
      count,
      share: Math.round((1000 * count) / dated) / 10,
    }));

  const peak = weeks.reduce<SeasonalityWeek | null>((best, w) => (best == null || w.count > best.count ? w : best), null);
  const peakMonth = months.reduce<SeasonalityMonth | null>((best, m) => (best == null || m.count > best.count ? m : best), null);
  const avg = dated / weeks.length;

  return {
    dated,
    weeks,
    months,
    from: weeks[0]?.from ?? null,
    to: weeks[weeks.length - 1]?.to ?? null,
    peak,
    peakMonth,
    peakRatio: peak && avg > 0 ? Math.round((10 * peak.count) / avg) / 10 : null,
  };
}
