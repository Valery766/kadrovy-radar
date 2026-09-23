/**
 * «Штат и удержание»: сравнение ставок действующих сотрудников с рынком.
 * Чистая функция ядра — на вход список должностей и готовые карточки рынка,
 * на выходе риск ухода по каждой позиции и стоимость выхода на медиану.
 */
import type { MarketCard, OfferBand, StaffAssessment, StaffPosition, StaffReport, StaffRisk, StaffSummary } from './types.js';
import { percentileFromHistogram } from './stats.js';
import { bandOf } from './verdict.js';

export const RISK_LABEL: Record<StaffRisk, string> = {
  high: 'высокий риск ухода',
  medium: 'умеренный риск',
  none: 'в рынке',
  unknown: 'нет данных',
};

function assessOne(position: StaffPosition, card: MarketCard | undefined | null): StaffAssessment {
  const professionKey = position.professionKey ?? null;
  const base = {
    id: position.id,
    title: position.title,
    salary: position.salary,
    professionKey,
    professionTitle: card?.professionTitle ?? null,
  };
  if (!card || !card.stats) {
    return {
      ...base,
      percentile: null, band: null, median: null, p25: null, p75: null,
      gapRub: 0, gapPct: 0, risk: 'unknown',
      note: card ? 'По этой должности рынок не набрал вакансий с зарплатой' : 'Рынок по этой должности не рассчитан',
    };
  }
  const { median, p25, p75 } = card.stats;
  const percentile = percentileFromHistogram(card.histogram, position.salary);
  const band: OfferBand | null = percentile == null ? null : bandOf(percentile);
  const gapRub = Math.max(0, median - position.salary);
  const gapPct = position.salary > 0 ? Math.round((1000 * gapRub) / position.salary) / 10 : 0;
  const risk: StaffRisk = position.salary < p25 ? 'high' : position.salary < median ? 'medium' : 'none';
  return { ...base, percentile, band, median, p25, p75, gapRub, gapPct, risk, note: null };
}

function summarize(items: StaffAssessment[]): StaffSummary {
  const assessed = items.filter((x) => x.risk !== 'unknown');
  const payroll = items.reduce((s, x) => s + x.salary, 0);
  const costToMedian = assessed.reduce((s, x) => s + x.gapRub, 0);
  const percentiles = assessed.map((x) => x.percentile).filter((x): x is number => x != null).sort((a, b) => a - b);
  const mid = percentiles.length
    ? percentiles.length % 2
      ? percentiles[(percentiles.length - 1) / 2]!
      : Math.round((percentiles[percentiles.length / 2 - 1]! + percentiles[percentiles.length / 2]!) / 2)
    : null;
  return {
    positions: items.length,
    assessed: assessed.length,
    unknown: items.length - assessed.length,
    highRisk: items.filter((x) => x.risk === 'high').length,
    mediumRisk: items.filter((x) => x.risk === 'medium').length,
    inMarket: items.filter((x) => x.risk === 'none').length,
    payroll,
    costToMedian,
    /** Сколько процентов к текущему фонду оплаты труда добавит выход на медиану. */
    costShare: payroll > 0 ? Math.round((1000 * costToMedian) / payroll) / 10 : 0,
    medianPercentile: mid,
  };
}

/**
 * Оценка штата: перцентиль ставки, разрыв до медианы и риск ухода по каждой позиции
 * плюс итоговая сводка. Позиции без рынка попадают в раздел «нет данных» и не искажают суммы.
 */
export function assessStaff(positions: StaffPosition[], markets: Map<string, MarketCard>): StaffReport {
  const items = positions.map((p) => assessOne(p, p.professionKey ? markets.get(p.professionKey) : null));
  // Сначала самые «отстающие»: высокий риск → умеренный → в рынке → без данных; внутри — по разрыву.
  const order: Record<StaffRisk, number> = { high: 0, medium: 1, none: 2, unknown: 3 };
  const sorted = [...items].sort((a, b) => order[a.risk] - order[b.risk] || b.gapRub - a.gapRub || a.title.localeCompare(b.title, 'ru'));
  return { positions: sorted, summary: summarize(items) };
}
