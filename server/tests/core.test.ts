import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { computeMarket, dedupeVacancies, matchTitle, percentileOf, quantileSorted, histogram, buildVacancyDraft } from '../src/core/index.js';
import type { Pack, Profession, Thresholds, VacancyRecord } from '../src/core/index.js';
import { mapVacancy, type RawVacancy } from '../src/integrations/trudvsem.js';
import { parseJsonLenient } from '../src/integrations/http.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/trudvsem-povar-spb.json', import.meta.url), 'utf8')) as {
  results: { vacancies: { vacancy: RawVacancy }[] };
};
const povar: Profession = {
  key: 'povar', title: 'Повар', query: 'повар',
  synonyms: ['повар'], exclude: ['шеф-повар', 'су-шеф', 'помощник повара', 'бренд-шеф'],
};
const thresholds: Thresholds = { minEmployers: 10, minVacancies: 20, salaryMin: 15000, salaryMax: 500000, perEmployerCap: 3 };
const vacancies: VacancyRecord[] = fixture.results.vacancies.map((x) => mapVacancy(x.vacancy, '7800000000000'));

describe('normalize', () => {
  it('matches synonyms and applies exclusions', () => {
    expect(matchTitle('Повар-универсал', povar)).toEqual({ matched: true });
    expect(matchTitle('Шеф-повар', povar)).toEqual({ matched: false, reason: 'excluded' });
    expect(matchTitle('Официант', povar)).toEqual({ matched: false, reason: 'no_synonym' });
    expect(matchTitle('ПОВАР горячего цеха', povar).matched).toBe(true);
  });
});

describe('stats', () => {
  it('computes type-7 quantiles', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([10, 20, 30, 40, 50], 0.25)).toBe(20);
    expect(quantileSorted([7], 0.9)).toBe(7);
  });
  it('percentile is share strictly below', () => {
    expect(percentileOf([10, 20, 30, 40], 25)).toBe(50);
    expect(percentileOf([10, 20, 30, 40], 5)).toBe(0);
    expect(percentileOf([10, 20, 30, 40], 100)).toBe(100);
  });
  it('histogram uses round bucket borders', () => {
    const h = histogram([40000, 45000, 60000, 70000, 90000, 120000]);
    expect(h.length).toBeGreaterThan(3);
    expect(h.reduce((s, b) => s + b.count, 0)).toBe(6);
    expect(h[0]!.from % 1000).toBe(0);
  });
});

describe('dedupe', () => {
  it('collapses exact duplicates and caps per employer', () => {
    const base: VacancyRecord = { ...vacancies[0]!, employerInn: '1', title: 'Повар', salaryMin: 50000, salaryMax: 50000 };
    const list = [1, 2, 3, 4, 5].map((i) => ({ ...base, id: String(i) }));
    const r1 = dedupeVacancies(list, 3);
    expect(r1.kept.length).toBe(1);
    expect(r1.duplicates).toBe(4);
    const varied = [1, 2, 3, 4, 5].map((i) => ({ ...base, id: String(i), salaryMin: 50000 + i * 1000, salaryMax: 50000 + i * 1000 }));
    const r2 = dedupeVacancies(varied, 3);
    expect(r2.kept.length).toBe(3);
    expect(r2.capped).toBe(2);
  });
});

describe('computeMarket on real fixture (повар, Санкт-Петербург)', () => {
  const card = computeMarket({
    vacancies, profession: povar, regionCode: '7800000000000', regionName: 'Санкт-Петербург',
    offer: 45000, thresholds, requirementPhrases: [
      { key: 'medbook', label: 'медкнижка', patterns: ['медкниж', 'медицинск\\w* книж', 'санитарн\\w* книж'] },
      { key: 'exp', label: 'опыт работы', patterns: ['опыт'] },
    ], userCategory: 1, now: new Date('2026-09-23'),
  });
  it('keeps only cooks with plausible salaries and reports the sample honestly', () => {
    expect(card.sample.fetched).toBe(100);
    expect(card.sample.vacancies).toBeGreaterThan(20);
    expect(card.sample.vacancies).toBeLessThan(100);
    expect(card.sample.employers).toBeGreaterThan(10);
    expect(Object.values(card.sample.dropped).reduce((a, b) => a + b, 0) + card.sample.vacancies).toBe(100);
  });
  it('produces stats, offer percentile, options and verdict', () => {
    expect(card.stats).not.toBeNull();
    expect(card.stats!.p25).toBeLessThanOrEqual(card.stats!.median);
    expect(card.stats!.median).toBeLessThanOrEqual(card.stats!.p75);
    expect(card.offer!.percentile).toBeGreaterThanOrEqual(0);
    expect(card.offer!.percentile).toBeLessThanOrEqual(100);
    expect(card.options.map((o) => o.kind)).toEqual(['keep', 'median', 'top']);
    expect(card.options[1]!.value % 1000).toBe(0);
    expect(card.options[2]!.value).toBeGreaterThan(card.options[1]!.value);
    expect(card.verdict).toContain('45 000 ₽');
    expect(card.verdict).toContain('Медиана');
    expect(card.requirements.length).toBeGreaterThan(0);
  });
  it('is deterministic', () => {
    const again = computeMarket({ vacancies, profession: povar, regionCode: '7800000000000', regionName: 'Санкт-Петербург', offer: 45000, thresholds, requirementPhrases: [], userCategory: null, now: new Date('2026-09-23') });
    expect(again.stats).toEqual(card.stats);
    expect(again.offer).toEqual(card.offer);
  });
  it('flags low confidence on a small sample and none on empty', () => {
    const small = computeMarket({ vacancies: vacancies.slice(0, 8), profession: povar, regionCode: '78', regionName: 'СПб', offer: 45000, thresholds, requirementPhrases: [], userCategory: null });
    expect(['low', 'none']).toContain(small.confidence);
    const empty = computeMarket({ vacancies: [], profession: povar, regionCode: '78', regionName: 'СПб', offer: 45000, thresholds, requirementPhrases: [], userCategory: null });
    expect(empty.confidence).toBe('none');
    expect(empty.stats).toBeNull();
    expect(empty.verdict).toContain('не нашлось');
  });
  it('builds a deterministic vacancy draft', () => {
    const pack = { vacancyTemplate: { conditions: ['официальное оформление', 'питание за счёт компании'] } } as unknown as Pack;
    const text = buildVacancyDraft({ card, profession: povar, pack, salary: 70000, companyName: 'ООО «Малый 43»', cityName: 'Санкт-Петербург' });
    expect(text).toContain('Повар — Санкт-Петербург');
    expect(text).toContain('70 000 ₽');
    expect(text).toContain('официальное оформление');
  });
});

describe('lenient JSON', () => {
  it('repairs invalid escapes from the source', () => {
    const broken = '{"a":"график 5\\2, в 7:00"}';
    expect(parseJsonLenient<{ a: string }>(broken, 'test').a).toContain('5');
    expect(() => parseJsonLenient('{oops', 'test')).toThrow();
  });
});
