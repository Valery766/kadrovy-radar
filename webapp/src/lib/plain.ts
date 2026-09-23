/**
 * Простые формулировки для чисел (docs/plain-language.md).
 * Каждое число на экране сопровождается словами, что оно значит для владельца бизнеса.
 * Все фразы считаются на клиенте из полей ответа API: контракты сервера не меняются.
 */
import { rub } from './api';

export type Band = 'low' | 'below_median' | 'market' | 'above';

/** Форма слова по числу: plural(3, 'объявление', 'объявления', 'объявлений'). */
export const plural = (n: number, one: string, few: string, many: string): string => {
  const a = Math.abs(Math.round(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

/** «258 объявлений». */
export const nWord = (n: number, one: string, few: string, many: string): string =>
  `${Math.round(n).toLocaleString('ru-RU')} ${plural(n, one, few, many)}`;

export const ads = (n: number) => nWord(n, 'объявление', 'объявления', 'объявлений');
export const adsDat = (n: number) => nWord(n, 'объявлению', 'объявлениям', 'объявлениям');
export const employers = (n: number) => nWord(n, 'работодателя', 'работодателей', 'работодателей');
export const people = (n: number) => nWord(n, 'сотрудник', 'сотрудника', 'сотрудников');
export const peopleGen = (n: number) => nWord(n, 'сотрудника', 'сотрудников', 'сотрудников');

/** Процент с русской запятой: «43,6 %». */
export const pctWord = (n: number): string => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`;

/** «45 625–76 000 ₽». */
export const rubRange = (a: number, b: number): string => `${Math.round(a).toLocaleString('ru-RU')}–${rub(b)}`;

/** Дата источника: «на 23.09». */
export const onDate = (iso: string): string =>
  `на ${new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' })}`;

/** «2026-08-24» → «24.08». */
export const dayShort = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}` : iso;
};

/** «в 2 раза», «в 4,7 раза», «в 5 раз». */
export const timesWord = (t: number): string => {
  if (t >= 5) return `в ${Math.round(t)} раз`;
  const s = t.toFixed(1).replace(/\.0$/, '').replace('.', ',');
  return `в ${s} раза`;
};

/** Одна фраза-вывод о ставке. above – сколько из 100 работодателей платят больше (100 минус перцентиль). */
export function offerVerdict(band: Band, above: number): string {
  const shareAbove = above;
  switch (band) {
    case 'low': return `Вы платите меньше большинства: ${shareAbove} из 100 работодателей предлагают больше`;
    case 'below_median': return `Вы платите меньше половины работодателей: ${shareAbove} из 100 предлагают больше`;
    case 'market': return `Вы платите как большинство: больше предлагают только ${shareAbove} из 100 работодателей`;
    case 'above': return `Вы платите больше большинства: больше предлагают лишь ${shareAbove} из 100 работодателей`;
  }
}

/** Короткий ярлык для плашек и таблиц. */
export const bandWords = (band: Band): string =>
  (band === 'low' ? 'меньше большинства' : band === 'below_median' ? 'меньше половины' : band === 'market' ? 'как большинство' : 'больше большинства');

export const bandClass = (band: Band): string =>
  (band === 'low' ? 'sv-badge--bad' : band === 'below_median' ? 'sv-badge--warn' : 'sv-badge--ok');

/** «Посчитано по 258 объявлениям 234 работодателей. Ещё 444 объявления не подошли: …». */
export function sampleWords(sample: { vacancies: number; employers: number }, total: number): string {
  const head = `Посчитано по ${adsDat(sample.vacancies)} ${employers(sample.employers)}.`;
  const rest = total - sample.vacancies;
  return rest > 0 ? `${head} Ещё ${ads(rest)} не подошли: без зарплаты, повторы или другая должность.` : head;
}

const DROP_WORDS: Record<string, string> = {
  no_salary: 'без зарплаты',
  other_role: 'другая должность',
  title_mismatch: 'название не совпало',
  duplicates: 'повторы',
  employer_cap: 'лишние объявления одного работодателя',
};

/** «без зарплаты – 120, повторы – 56». */
export const droppedWords = (dropped: Record<string, number>): string =>
  Object.entries(dropped).filter(([, v]) => v > 0).map(([k, v]) => `${DROP_WORDS[k] ?? k} – ${v}`).join(', ');

/** Размер компании по реестру МСП простыми словами. */
export const categoryWords = (c: 0 | 1 | 2 | 3 | null | undefined): string =>
  (c === 1 ? 'микропредприятия, до 15 сотрудников' : c === 2 ? 'малые предприятия, до 100 сотрудников' : c === 3 ? 'средние предприятия, до 250 сотрудников' : 'крупные компании и бюджетные учреждения');

export const categoryShort = (c: 0 | 1 | 2 | 3 | null | undefined): string =>
  (c === 1 ? 'Микропредприятия' : c === 2 ? 'Малые предприятия' : c === 3 ? 'Средние предприятия' : 'Крупные компании и бюджет');

/** Родительный падеж: «у микропредприятий», «у крупных компаний и бюджетных учреждений». */
export const categoryGen = (c: 0 | 1 | 2 | 3 | null | undefined): string =>
  (c === 1 ? 'микропредприятий' : c === 2 ? 'малых предприятий' : c === 3 ? 'средних предприятий' : 'крупных компаний и бюджетных учреждений');

/** Только размер: «до 15 сотрудников». */
export const categorySize = (c: 0 | 1 | 2 | 3 | null | undefined): string =>
  (c === 1 ? 'до 15 сотрудников' : c === 2 ? 'до 100 сотрудников' : c === 3 ? 'до 250 сотрудников' : 'нет в реестре малого бизнеса');

/**
 * Насколько должность дешевле средней зарплаты региона (индекс доступности словами).
 * ratio = обычная ставка должности / средняя зарплата региона.
 */
export function cheaperWords(ratio: number): string {
  if (ratio < 0.92) {
    const times = 1 / ratio;
    if (times >= 1.45) return `дешевле средней зарплаты по региону ${timesWord(times)}`;
    return `на ${Math.round((1 - ratio) * 100)} % дешевле средней зарплаты по региону`;
  }
  if (ratio <= 1.08) return 'почти как средняя зарплата по региону';
  return `на ${Math.round((ratio - 1) * 100)} % дороже средней зарплаты по региону`;
}

/** Совпадение отклика с вакансией словами. */
export function matchWords(score: number, max: number): string {
  const r = max > 0 ? score / max : 0;
  return r >= 0.75 ? 'хорошее совпадение' : r >= 0.5 ? 'частичное совпадение' : 'слабое совпадение';
}

export const matchClass = (score: number, max: number): string => {
  const r = max > 0 ? score / max : 0;
  return r >= 0.75 ? 'sv-badge--ok' : r >= 0.5 ? 'sv-badge--warn' : 'sv-badge--muted';
};

/** Ожидания кандидата по деньгам относительно ставки вакансии. */
export function expectationWords(expected: number | null, vacancySalary: number | null): string {
  if (expected == null) return 'как в вакансии';
  if (!vacancySalary) return rub(expected);
  const diff = expected / vacancySalary;
  if (diff <= 1) return `${rub(expected)}, не выше вашей ставки`;
  const pct = Math.round((diff - 1) * 100);
  return diff <= 1.3 ? `${rub(expected)}, чуть выше вашей ставки (+${pct} %)` : `${rub(expected)}, заметно выше вашей ставки (+${pct} %)`;
}

/** Месяц «2026-08» → «в августе 2026». */
const MONTH_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
export const inMonth = (key: string): string => {
  const m = Number(key.slice(5, 7)) - 1;
  return `в ${MONTH_PREP[m] ?? key} ${key.slice(0, 4)}`;
};
const MONTH_PREP_PREV = ['декабре', 'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре'];
export const inPrevMonth = (key: string): string => `в ${MONTH_PREP_PREV[Number(key.slice(5, 7)) - 1] ?? 'предыдущем месяце'}`;

/** Штат: вывод по одному сотруднику. */
export function staffPositionWords(p: {
  risk: 'high' | 'medium' | 'none' | 'unknown'; percentile: number | null; gapRub: number; gapPct: number; note: string | null;
}): string {
  const above = p.percentile != null ? `${100 - p.percentile} из 100` : null;
  if (p.risk === 'unknown') return p.note ?? 'По этой должности рынок не посчитан.';
  if (p.risk === 'high') {
    return `${above ? `Получает меньше, чем в ${above} объявлений` : 'Получает меньше четверти самых экономных работодателей'}: такого сотрудника легко переманить. Чтобы платить как большинство, доплатите ${rub(p.gapRub)} в месяц (+${pctWord(p.gapPct)}).`;
  }
  if (p.risk === 'medium') {
    return `Получает меньше обычной ставки, но не в зоне риска${above ? `: больше платят ${above} работодателей` : ''}. Доплата до обычной ставки: ${rub(p.gapRub)} в месяц (+${pctWord(p.gapPct)}).`;
  }
  return `Получает как большинство или больше${above ? `: больше платят только ${above} работодателей` : ''}. Доплачивать не нужно.`;
}

/** Штат: вывод одной фразой по всему списку. */
export function staffLead(s: { assessed: number; highRisk: number; mediumRisk: number }): string {
  if (s.assessed === 0) return 'По этим должностям рынок не посчитан: попробуйте другие названия';
  if (s.highRisk > 0) {
    if (s.assessed === 1) return 'Вашего сотрудника легко переманить: ставка ниже, чем у трёх четвертей работодателей';
    return `Легко переманить ${s.highRisk} из ${peopleGen(s.assessed)}: ставка ниже, чем у трёх четвертей работодателей`;
  }
  if (s.mediumRisk > 0) {
    if (s.assessed === 1) return 'Сотрудник получает меньше обычной ставки, но пока не в зоне риска';
    return `${s.mediumRisk} из ${peopleGen(s.assessed)} ${s.mediumRisk === 1 ? 'получает' : 'получают'} меньше обычной ставки, но пока не в зоне риска`;
  }
  return 'Все сотрудники получают как большинство на рынке или больше';
}

/** Штат: что это значит для фонда оплаты. */
export function staffMeaning(s: { payroll: number; costToMedian: number; costShare: number; medianPercentile: number | null; assessed: number }): string {
  const parts: string[] = [];
  if (s.costToMedian > 0) parts.push(`Чтобы все получали обычную рыночную ставку, фонд оплаты вырастет на ${rub(s.costToMedian)} в месяц: это +${pctWord(s.costShare)} к нынешним ${rub(s.payroll)}.`);
  else if (s.assessed > 0) parts.push('Доплачивать никому не нужно: все ставки не ниже обычной рыночной.');
  if (s.medianPercentile != null && s.assessed > 1) parts.push(`Типичный ваш сотрудник получает больше, чем в ${s.medianPercentile} из 100 объявлений региона.`);
  return parts.join(' ');
}

/** Регионы: вывод одной фразой. */
export function regionsLead(professionTitle: string, rows: { regionName: string; median: number | null }[], spreadPct: number | null): string {
  const withData = rows.filter((r): r is { regionName: string; median: number } => r.median != null);
  if (withData.length === 0) return `По должности «${professionTitle}» ни в одном из регионов не нашлось объявлений с зарплатой`;
  const cheapest = withData.reduce((a, b) => (b.median < a.median ? b : a));
  const dearest = withData.reduce((a, b) => (b.median > a.median ? b : a));
  if (withData.length === 1) return `Обычная ставка «${professionTitle}» в регионе ${cheapest.regionName} – ${rub(cheapest.median)}`;
  const spread = spreadPct != null ? `, на ${Math.round(spreadPct)} % больше` : '';
  return `Дешевле всего нанять: ${cheapest.regionName}, ${rub(cheapest.median)}. Дороже всего: ${dearest.regionName}, ${rub(dearest.median)}${spread}`;
}

/** Плановые проверки: кто придёт и что проверит. */
export const INSPECTION_WORDS: Record<'labor' | 'sanitary' | 'fire' | 'other', { who: string; what: string }> = {
  labor: { who: 'Трудовая инспекция', what: 'проверят трудовые договоры, зарплату и охрану труда' },
  sanitary: { who: 'Роспотребнадзор', what: 'проверят санитарные нормы, продукты и медкнижки' },
  fire: { who: 'Пожарный надзор', what: 'проверят пожарную безопасность помещения' },
  other: { who: 'Другие ведомства', what: 'проверка по своему профилю надзора' },
};
