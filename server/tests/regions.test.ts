import { describe, expect, it } from 'vitest';
import { compareRegionMarkets } from '../src/core/index.js';
import type { RegionMarketInput, SalaryStats } from '../src/core/index.js';
import { regionsText } from '../src/services/regions.js';

const stats = (median: number, p25 = median - 10000, p75 = median + 10000): SalaryStats => ({
  n: 50, median, p25, p75, min: p25 - 5000, max: p75 + 5000, mean: median,
});

const inputs: RegionMarketInput[] = [
  { fnsCode: '78', regionName: 'Санкт-Петербург', avgSalary: 121475, stats: stats(65000), vacancies: 258, employers: 234, histogram: [{ from: 40000, to: 60000, count: 20 }, { from: 60000, to: 80000, count: 30 }] },
  { fnsCode: '23', regionName: 'Краснодарский край', avgSalary: 76115, stats: stats(50000), vacancies: 120, employers: 90, histogram: [{ from: 30000, to: 50000, count: 40 }, { from: 50000, to: 70000, count: 10 }] },
  { fnsCode: '16', regionName: 'Республика Татарстан', avgSalary: 90515, stats: stats(55000), vacancies: 300, employers: 210, histogram: [{ from: 40000, to: 60000, count: 50 }] },
  { fnsCode: '99', regionName: 'Недоступный регион', avgSalary: 50000, stats: null, vacancies: 0, employers: 0, error: '«Работа России» сейчас недоступна' },
];

describe('compareRegionMarkets', () => {
  it('sorts by median and numbers the ranks', () => {
    const r = compareRegionMarkets(inputs);
    expect(r.rows.slice(0, 3).map((x) => x.fnsCode)).toEqual(['23', '16', '78']);
    expect(r.rows.slice(0, 3).map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(r.summary.cheapest).toBe('23');
    expect(r.summary.medianMin).toBe(50000);
    expect(r.summary.medianMax).toBe(65000);
    expect(r.summary.spreadPct).toBe(30);
  });

  it('computes the affordability index against the regional average salary', () => {
    const r = compareRegionMarkets(inputs);
    const spb = r.rows.find((x) => x.fnsCode === '78')!;
    expect(spb.affordability).toBeCloseTo(0.54, 2);
    const krd = r.rows.find((x) => x.fnsCode === '23')!;
    expect(krd.affordability).toBeCloseTo(0.66, 2);
    // Индекс доступности спорит с медианой: в Петербурге повар дороже, но относительно рынка — дешевле.
    expect(r.summary.bestAffordability).toBe('78');
  });

  it('keeps failed regions at the end without breaking the rest', () => {
    const r = compareRegionMarkets(inputs);
    expect(r.rows.at(-1)!.fnsCode).toBe('99');
    expect(r.rows.at(-1)!.rank).toBe(0);
    expect(r.rows.at(-1)!.error).toBeTruthy();
    expect(r.summary.regions).toBe(4);
    expect(r.summary.withData).toBe(3);
    expect(r.summary.failed).toBe(1);
  });

  it('supports sorting by affordability and by the number of vacancies', () => {
    expect(compareRegionMarkets(inputs, { sortBy: 'affordability' }).rows[0]!.fnsCode).toBe('78');
    expect(compareRegionMarkets(inputs, { sortBy: 'vacancies' }).rows[0]!.fnsCode).toBe('16');
    expect(compareRegionMarkets(inputs, { sortBy: 'vacancies' }).sortBy).toBe('vacancies');
  });

  it('places the offer on each regional scale', () => {
    const r = compareRegionMarkets(inputs, { offer: 50000 });
    expect(r.rows.find((x) => x.fnsCode === '78')!.offerPercentile).toBe(20);
    expect(r.rows.find((x) => x.fnsCode === '23')!.offerPercentile).toBe(80);
    expect(r.rows.find((x) => x.fnsCode === '99')!.offerPercentile).toBeNull();
  });

  it('is deterministic and survives an all-empty input', () => {
    expect(compareRegionMarkets(inputs)).toEqual(compareRegionMarkets(inputs));
    const empty = compareRegionMarkets([]);
    expect(empty.rows).toEqual([]);
    expect(empty.summary.cheapest).toBeNull();
    expect(empty.summary.spreadPct).toBeNull();
  });

  it('renders a Russian comparison text', () => {
    const text = regionsText('Повар', compareRegionMarkets(inputs, { offer: 50000 }), 50000);
    expect(text).toContain('Краснодарский край');
    expect(text).toContain('индекс доступности');
    expect(text).toContain('Не удалось посчитать: Недоступный регион');
  });
});
