/**
 * Тексты бота по словарю простых формулировок: без длинных тире, каждое число объяснено,
 * ответ с цифрами заканчивается блоком «Что дальше», подписи кнопок укладываются в лимит.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCatalog, selectPack } from '../src/packs/loader.js';
import { buildVerdict, type MarketCard } from '../src/core/index.js';
import type { MarketResult } from '../src/services/market.js';
import type { VacancyRow } from '../src/db/index.js';
import type { BusinessProfile } from '../src/integrations/rmsp.js';
import * as T from '../src/bot/texts.js';

const catalog = loadCatalog(resolve(import.meta.dirname, '../../packs'));
const pack = selectPack(catalog, { fnsRegionCode: '78', okved: '56.10' });

/** Карточка с числами из примера заказчика: повар, Санкт-Петербург, ставка 45 000 ₽. */
export function referenceResult(): MarketResult {
  const base: Omit<MarketCard, 'verdict'> = {
    professionKey: 'povar', professionTitle: 'Повар', regionCode: '7800000000000',
    sample: { fetched: 702, vacancies: 258, employers: 234, topEmployerShare: 3, dropped: { no_salary: 300, other_role: 100, duplicates: 30, employer_cap: 14 } },
    confidence: 'ok', confidenceReason: null,
    stats: { n: 258, median: 65000, p25: 45625, p75: 76000, min: 30000, max: 150000, mean: 64000 },
    fixedShare: 50, recentMedian: 66000,
    offer: { value: 45000, percentile: 22, band: 'low', shareAbove: 78 },
    options: [
      { kind: 'keep', value: 45000, percentile: 22, label: 'Оставить как есть' },
      { kind: 'median', value: 65000, percentile: 50, label: 'Выйти на медиану' },
      { kind: 'top', value: 76000, percentile: 75, label: 'В верхнюю четверть' },
    ],
    histogram: [],
    byCategory: [{ category: 1, label: 'микропредприятия', employers: 12, vacancies: 30, median: 80000 }],
    sameSize: { category: 1, label: 'микропредприятия', employers: 12, vacancies: 30, median: 80000 },
    examples: [],
    requirements: [{ key: 'exp', label: 'опыт', count: 140, share: 54 }, { key: 'med', label: 'медкнижка', count: 80, share: 31 }],
    schedules: [{ label: 'Сменный', share: 60 }],
    seasonality: null,
  };
  const card: MarketCard = { ...base, verdict: buildVerdict(base, 'Повар', 'Санкт-Петербург') };
  return {
    cardId: 'card-ref', card,
    pack: { id: pack.id, title: pack.title, version: pack.version },
    profession: { key: 'povar', title: 'Повар', query: 'повар' },
    region: { code: '7800000000000', fnsCode: '78', name: 'Санкт-Петербург', avgSalary: 121475, unemployment: 2 },
    profile: null, sources: [],
    fetched: { total: 702, records: 258, cacheHit: false, fetchedAt: '2026-09-23T09:00:00.000Z' },
    closure: null, createdAt: '2026-09-23T09:00:00.000Z',
  } as unknown as MarketResult;
}

const vacancy = { id: 'v1', title: 'Повар', salary: 65000, status: 'open', employerName: 'ООО «Малый 43»', regionCode: '7800000000000', text: 'Повар – Санкт-Петербург\nГрафик: сменный 2/2' } as unknown as VacancyRow;
const profile: BusinessProfile = { inn: '7801633015', ogrn: '1', name: 'ООО «МАЛЫЙ 43»', category: 1, okved: '56.10', okvedName: 'Деятельность ресторанов', fnsRegionCode: '78', kind: 'UL', registeredAt: '2020-01-01', active: true, excerptToken: null, inRegistry: true, fetchedAt: '2026-09-23T05:00:00.000Z' };

/** Все экспортируемые тексты с типовыми аргументами. */
function renderedTexts(): Record<string, string> {
  const r = referenceResult();
  return {
    welcome: T.welcomeText('Валерий'), welcomeAnon: T.welcomeText(null), guide: T.guideText(), help: T.helpText(),
    askInn: T.askInnText(), askRegionSkip: T.askRegionText('skip'), askRegionFirst: T.askRegionText('first'),
    profile: T.profileText(profile, pack, 'Санкт-Петербург', 'Проверки 2026: плановых по вашему ИНН нет'),
    profileMissing: T.profileText({ ...profile, inRegistry: false }, pack, null),
    askProfession: T.askProfessionText(pack), askSalary: T.askSalaryText('Повар'),
    card: T.cardText(r), cardNoOffer: T.cardText({ ...r, card: { ...r.card, offer: null, options: r.card.options.slice(1) } }),
    cardLow: T.cardText({ ...r, card: { ...r.card, confidence: 'low', confidenceReason: 'Мало данных: 8 вакансий, 5 работодателей (нужно ≥ 20 и ≥ 10)' } }),
    cardNone: T.cardText({ ...r, card: { ...r.card, confidence: 'none', stats: null, verdict: 'По запросу «Повар» ничего не нашлось.' } }),
    draft: T.draftText('Повар – Санкт-Петербург'), vote: T.voteText('Повар', { kind: 'median', value: 65000 }, r.card.options, { median: 2 }, 2),
    subscribed: T.subscribedText('Повар', 'Санкт-Петербург'),
    published: T.publishedVacancyText(vacancy, 'Санкт-Петербург', 'https://max.ru/test_bot?start=vac_v1'),
    candidate: T.candidateVacancyText(vacancy, 'Санкт-Петербург'), candidateClosed: T.candidateVacancyText({ ...vacancy, status: 'closed' } as VacancyRow, 'Санкт-Петербург'),
    askExperience: T.askExperienceText, askSchedule: T.askScheduleText(vacancy), askExpectation: T.askSalaryExpectationText(vacancy), askPhone: T.askPhoneText,
    sentWithPhone: T.responseSentText(true), sentNoPhone: T.responseSentText(false),
    vacancies: T.vacanciesListText([{ title: 'Повар', responses: 3, newResponses: 1, status: 'open' }]), vacanciesEmpty: T.vacanciesListText([]),
    subs: T.subsText([{ title: 'Повар, Санкт-Петербург' }]), subsEmpty: T.subsText([]),
    suggest: T.professionSuggestText('повар-сушист', [{ title: 'Повар', source: 'catalog' }, { title: 'Сушист', source: 'okpdtr' }]), suggestNone: T.professionSuggestText('космонавт', []),
    staffIntro: T.staffIntroText('Санкт-Петербург'), staffAdded: T.staffAddedText(2, 3, ['абракадабра']),
    askRegions: T.askRegionsText('Повар', 4), askRegionsProfession: T.askRegionsProfessionText,
    demoChoice: T.demoChoiceText(), demoIntro: T.demoIntroText('ООО «Малый 43» — микропредприятие', 'Повар', 45000), fallback: T.fallbackText(),
  };
}

describe('тексты бота по словарю', () => {
  it('в исходнике texts.ts нет длинных тире', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/bot/texts.ts'), 'utf8');
    expect(src).not.toContain('—');
  });

  it('ни один экспортируемый текст не содержит длинного тире и не пуст', () => {
    for (const [name, text] of Object.entries(renderedTexts())) {
      expect(text.length, name).toBeGreaterThan(20);
      expect(text, name).not.toContain('—');
    }
  });

  it('карточка ставки объясняет каждое число словами и заканчивается «Что дальше» и источником', () => {
    const text = T.cardText(referenceResult());
    expect(text).toContain('Вы платите меньше большинства');
    expect(text).toContain('78 из 100 работодателей');
    expect(text).toContain('Только 22 из 100 работодателей платят меньше (22-й перцентиль)');
    expect(text).toContain('Обычная ставка рынка: 65 000 ₽ (медиана)');
    expect(text).toContain('Коридор половины вакансий: 45 625 ₽–76 000 ₽. Ваша ставка ниже этого коридора');
    expect(text).toContain('микропредприятия, до 15 сотрудников) платят 80 000 ₽ – больше, чем рынок в целом');
    expect(text).toContain('Что это значит для вас');
    expect(text).toContain('76 000 ₽ будете платить больше, чем три четверти работодателей');
    expect(text).toContain('Посчитано по 258 объявлениям 234 работодателей. Ещё 444 объявления не подошли: без зарплаты, другая должность');
    expect(text).toContain('По данным «Работы России» на 23.09');
    expect(text.indexOf('Что дальше:')).toBeGreaterThan(text.indexOf('Что это значит для вас'));
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  it('карточка без ставки и с малой выборкой тоже объясняет цифры', () => {
    const t = renderedTexts();
    expect(t.cardNoOffer).toContain('Обычная ставка «повар» в регионе – 65 000 ₽');
    expect(t.cardLow).toContain('Это слишком мало для вывода');
    expect(t.cardNone).toContain('Что дальше');
  });

  it('пошаговые подсказки говорят, какой это шаг и что будет дальше', () => {
    const t = renderedTexts();
    expect(t.askInn).toContain('Шаг 1 из 3');
    expect(t.askRegionSkip).toContain('Шаг 1 из 3');
    expect(t.askProfession).toContain('Шаг 2 из 3');
    expect(t.askSalary).toContain('Шаг 3 из 3');
    expect(t.askExperience).toContain('Вопрос 1 из 3');
    expect(t.askSchedule).toContain('Вопрос 2 из 3');
    expect(t.askExpectation).toContain('Вопрос 3 из 3');
    expect(t.askRegionsProfession).toContain('шаг 1 из 2');
    expect(t.askRegions).toContain('шаг 2 из 2');
    expect(t.staffIntro).toContain('«готово»');
    for (const name of ['card', 'published', 'sentWithPhone', 'vacancies', 'subs', 'staffIntro', 'profile', 'guide', 'help']) expect(t[name], name).toContain('Что дальше');
  });

  it('подписи кнопок укладываются в лимит клавиатуры', () => {
    const r = referenceResult();
    const keyboards = [
      T.welcomeKeyboard('test_bot'), T.guideKeyboard(), T.askInnKeyboard(), T.profileKeyboard(), T.professionKeyboard(pack), T.askSalaryKeyboard(),
      T.cardKeyboard({ ...r, card: { ...r.card, options: r.card.options.map((o) => ({ ...o, value: o.value * 3 })) } }, 'test_bot'),
      T.cardKeyboard(r, 'test_bot'), T.draftKeyboard(r, 'test_bot'), T.publishedVacancyKeyboard(vacancy, 'test_bot', 'https://max.ru/x'),
      T.candidateVacancyKeyboard(vacancy), T.experienceKeyboard('v1'), T.scheduleKeyboard('v1'), T.salaryExpectationKeyboard('v1'), T.phoneKeyboard('v1'),
      T.responseSentKeyboard(), T.vacanciesKeyboard('test_bot', [{ id: 'v1', title: 'Повар-универсал холодного цеха' }]),
      T.subsKeyboard([{ id: 's1', title: 'Повар-универсал, Санкт-Петербург' }]),
      T.professionSuggestKeyboard({ key: 'custom:x', title: 'очень длинное название должности' }, [{ key: 'a', title: 'Повар' }]),
      T.staffInputKeyboard(), T.staffKeyboard('test_bot'), T.regionsKeyboard('test_bot'), T.digestKeyboard('test_bot'), T.checksKeyboard('test_bot', true), T.askRegionKeyboard(),
    ];
    const labels: string[] = [];
    const walk = (x: unknown) => {
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        if (typeof o.text === 'string' && typeof o.type === 'string' && o.type !== 'inline_keyboard') labels.push(o.text);
        Object.values(o).forEach(walk);
      }
    };
    walk(keyboards);
    expect(labels.length).toBeGreaterThan(30);
    for (const label of labels) expect(label.length, label).toBeLessThanOrEqual(T.MAX_BUTTON_LABEL);
    expect(labels).toContain('Опубликовать 65 тыс.');
    expect(labels).toContain('Голос: обычная 65 тыс.');
  });
});
