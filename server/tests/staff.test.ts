import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assessStaff, computeMarket, percentileFromHistogram } from '../src/core/index.js';
import type { MarketCard, Profession, StaffPosition, Thresholds, VacancyRecord } from '../src/core/index.js';
import { mapVacancy, type RawVacancy } from '../src/integrations/trudvsem.js';
import { staffText } from '../src/services/staff.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/trudvsem-povar-spb.json', import.meta.url), 'utf8')) as {
  results: { vacancies: { vacancy: RawVacancy }[] };
};
const povar: Profession = {
  key: 'povar', title: 'Повар', query: 'повар',
  synonyms: ['повар'], exclude: ['шеф-повар', 'су-шеф', 'помощник повара', 'бренд-шеф'],
};
const thresholds: Thresholds = { minEmployers: 10, minVacancies: 20, salaryMin: 15000, salaryMax: 500000, perEmployerCap: 3 };
const vacancies: VacancyRecord[] = fixture.results.vacancies.map((x) => mapVacancy(x.vacancy, '7800000000000'));

const card: MarketCard = computeMarket({
  vacancies, profession: povar, regionCode: '7800000000000', regionName: 'Санкт-Петербург',
  offer: null, thresholds, requirementPhrases: [], userCategory: null, now: new Date('2026-09-23'),
});
const markets = new Map<string, MarketCard>([['povar', card]]);

describe('percentileFromHistogram', () => {
  it('returns 0 below the range, 100 above it and grows monotonically inside', () => {
    const h = [{ from: 0, to: 100, count: 1 }, { from: 100, to: 200, count: 3 }];
    expect(percentileFromHistogram(h, -10)).toBe(0);
    expect(percentileFromHistogram(h, 300)).toBe(100);
    expect(percentileFromHistogram(h, 100)).toBe(25);
    expect(percentileFromHistogram(h, 150)).toBe(63); // 1 + 1,5 из 4
    expect(percentileFromHistogram([], 50)).toBeNull();
  });
  it('agrees with the market card on its own median', () => {
    const p = percentileFromHistogram(card.histogram, card.stats!.median);
    expect(p).toBeGreaterThan(30);
    expect(p).toBeLessThan(70);
  });
});

describe('assessStaff on the real fixture (повар, Санкт-Петербург)', () => {
  const p25 = card.stats!.p25;
  const median = card.stats!.median;
  const positions: StaffPosition[] = [
    { id: 'a', title: 'Повар горячего цеха', salary: p25 - 10000, professionKey: 'povar' },
    { id: 'b', title: 'Повар холодного цеха', salary: Math.round((p25 + median) / 2), professionKey: 'povar' },
    { id: 'c', title: 'Повар-универсал', salary: median + 20000, professionKey: 'povar' },
    { id: 'd', title: 'Сушист', salary: 70000, professionKey: 'sushist' },
  ];
  const report = assessStaff(positions, markets);

  it('flags risk by percentile bands', () => {
    const byId = new Map(report.positions.map((x) => [x.id, x]));
    expect(byId.get('a')!.risk).toBe('high');
    expect(byId.get('b')!.risk).toBe('medium');
    expect(byId.get('c')!.risk).toBe('none');
    expect(byId.get('d')!.risk).toBe('unknown');
    expect(byId.get('d')!.note).toBeTruthy();
  });

  it('measures the gap to the median in roubles and percent', () => {
    const a = report.positions.find((x) => x.id === 'a')!;
    expect(a.median).toBe(median);
    expect(a.gapRub).toBe(median - (p25 - 10000));
    expect(a.gapPct).toBeCloseTo(Math.round((1000 * a.gapRub) / a.salary) / 10, 5);
    const c = report.positions.find((x) => x.id === 'c')!;
    expect(c.gapRub).toBe(0);
    expect(c.gapPct).toBe(0);
  });

  it('sums the cost of pulling everyone up to the median', () => {
    const { summary } = report;
    expect(summary.positions).toBe(4);
    expect(summary.assessed).toBe(3);
    expect(summary.unknown).toBe(1);
    expect(summary.highRisk).toBe(1);
    expect(summary.mediumRisk).toBe(1);
    expect(summary.inMarket).toBe(1);
    const expected = report.positions.filter((x) => x.risk !== 'unknown').reduce((s, x) => s + x.gapRub, 0);
    expect(summary.costToMedian).toBe(expected);
    expect(summary.payroll).toBe(positions.reduce((s, x) => s + x.salary, 0));
    expect(summary.costShare).toBeGreaterThan(0);
    expect(summary.medianPercentile).not.toBeNull();
  });

  it('puts the most lagging positions first and is deterministic', () => {
    expect(report.positions[0]!.id).toBe('a');
    expect(report.positions.at(-1)!.id).toBe('d');
    const again = assessStaff(positions, markets);
    expect(again).toEqual(report);
  });

  it('renders a Russian summary with the numbers of the report', () => {
    const text = staffText(report, 'Санкт-Петербург');
    expect(text).toContain('Санкт-Петербург');
    expect(text).toContain('высокий риск'.slice(0, 6));
    expect(text).toContain('Повар горячего цеха');
    expect(text).toContain('Выход на медиану рынка стоит');
  });

  it('survives an empty market without breaking the summary', () => {
    const empty = assessStaff(positions, new Map());
    expect(empty.summary.assessed).toBe(0);
    expect(empty.summary.costToMedian).toBe(0);
    expect(empty.summary.medianPercentile).toBeNull();
    expect(staffText(empty, 'Санкт-Петербург')).toContain('ни по одной должности');
  });
});
