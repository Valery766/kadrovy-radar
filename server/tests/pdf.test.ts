import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { computeMarket, type Profession, type Thresholds } from '../src/core/index.js';
import { mapVacancy, type RawVacancy } from '../src/integrations/trudvsem.js';
import { renderMarketPdf } from '../src/report/pdf.js';
import type { MarketResult } from '../src/services/market.js';

describe('pdf report', () => {
  it('renders a valid PDF with Cyrillic text', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/trudvsem-povar-spb.json', import.meta.url), 'utf8')) as { results: { vacancies: { vacancy: RawVacancy }[] } };
    const vacancies = fixture.results.vacancies.map((x) => mapVacancy(x.vacancy, '7800000000000'));
    const profession: Profession = { key: 'povar', title: 'Повар', query: 'повар', synonyms: ['повар'], exclude: ['шеф-повар'] };
    const thresholds: Thresholds = { minEmployers: 10, minVacancies: 20, salaryMin: 15000, salaryMax: 500000, perEmployerCap: 3 };
    const card = computeMarket({ vacancies, profession, regionCode: '7800000000000', regionName: 'Санкт-Петербург', offer: 45000, thresholds, requirementPhrases: [{ key: 'exp', label: 'опыт', patterns: ['опыт'] }], userCategory: 1 });
    const result: MarketResult = {
      cardId: 'test', card, pack: { id: 'spb-obschepit', title: 'Общепит · Санкт-Петербург', version: 1 }, profession,
      region: { code: '7800000000000', fnsCode: '78', name: 'Санкт-Петербург', avgSalary: 121475, unemployment: 2 },
      profile: { inn: '7801633015', ogrn: '1', name: 'ООО «МАЛЫЙ 43»', category: 1, okved: '56.10', okvedName: 'Деятельность ресторанов', fnsRegionCode: '78', kind: 'UL', registeredAt: '2020-01-01', active: true, excerptToken: null, inRegistry: true, fetchedAt: '2026-09-23T05:00:00.000Z' },
      sources: [{ id: 'trudvsem', title: '«Работа России»', url: 'https://trudvsem.ru', fetchedAt: '2026-09-23T05:00:00.000Z' }],
      fetched: { total: 702, records: 100, cacheHit: false, fetchedAt: '2026-09-23T05:00:00.000Z' }, closure: null, createdAt: '2026-09-23T05:00:00.000Z',
    };
    const pdf = await renderMarketPdf(result, { appUrl: 'https://max.ru/t796_hakaton_max_bot?startapp=card_test' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(20_000);
  });
});
