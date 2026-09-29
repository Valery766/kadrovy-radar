/**
 * Тексты и клавиатуры бота. Всё детерминированно: числа берутся из карточки ядра.
 * Правила текста: каждое число сопровождается объяснением, что оно значит для владельца;
 * ответ с цифрами строится по схеме «вывод → числа → что это значит → что дальше → источник»;
 * никаких длинных тире, только среднее «–» с пробелами.
 */
import { Keyboard } from '@maxhub/max-bot-api';

type KeyboardRows = Parameters<typeof Keyboard.inlineKeyboard>[0];
import { BAND_PLAIN, DROPPED_LABEL, formatDateTimeRu, formatRub, pluralRu, sizeLabel, sourceNote } from '../core/index.js';
import type { MarketCard, OfferBand } from '../core/index.js';
import type { MarketResult } from '../services/market.js';
import type { BusinessProfile } from '../integrations/rmsp.js';
import type { Pack } from '../core/index.js';
import type { VacancyRow } from '../db/index.js';
import { openRadarButton } from '../services/report.js';
import { inboxButton } from '../services/hiring.js';

export const fmtDate = formatDateTimeRu;

/** Подпись кнопки MAX: длиннее 22 символов ряд из двух-трёх кнопок не читается. */
export const MAX_BUTTON_LABEL = 22;
export function fitLabel(text: string, limit = MAX_BUTTON_LABEL): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}
const btn = (text: string, payload: string) => Keyboard.button.callback(fitLabel(text), payload);

/** Сумма в тысячах для кнопок: 65 000 ₽ → «65 тыс.». */
const thousands = (value: number) => `${Math.round(value / 1000)} тыс.`;

const vacanciesWord = (n: number) => pluralRu(n, 'объявление', 'объявления', 'объявлений');
const employersWord = (n: number) => pluralRu(n, 'работодателя', 'работодателей', 'работодателей');

/** Источник и дата: последняя строка любого ответа с цифрами. */
export const sourceLine = (fetchedAt: string): string => sourceNote(fetchedAt);

/* ---------- приветствие и путеводитель ---------- */

/** Первое сообщение: кто я, с чего начать. Подробности – в путеводителе следом. */
export function welcomeText(name: string | null): string {
  return [
    `${name ? `${name}, здравствуйте` : 'Здравствуйте'}! Это «Кадровый радар».`,
    'Работодателю: проверить зарплату → выбрать свою сумму → опубликовать вакансию → получить отклики.',
    'Кандидату: «Найти работу» → выбрать вакансию → откликнуться. Выберите, что нужно вам.',
  ].join('\n');
}

export function welcomeKeyboard(botUsername: string) {
  return Keyboard.inlineKeyboard([
    [btn('Проверить ставку', 'stavka'), btn('Найти работу', 'jobs')],
    [btn('Мои вакансии', 'vacancies'), btn('Что умеет бот', 'guide')],
    [openRadarButton(botUsername, null, 'Открыть приложение')],
  ]);
}

/** Пять возможностей бота: каждая с командой и кнопкой. Приходит вторым сообщением после приветствия и по /help. */
export const GUIDE_ITEMS: { text: string; commands: string[] }[] = [
  { text: 'Проверить зарплату по должности и региону, затем создать вакансию с любой своей суммой', commands: ['/stavka'] },
  { text: 'Посмотреть свои вакансии и ответы кандидатов', commands: ['/vacancies'] },
  { text: 'Найти вакансию в общем каталоге и откликнуться', commands: ['/jobs'] },
];

export function guideText(): string {
  const lines = ['Что умеет бот', ''];
  GUIDE_ITEMS.forEach((item, i) => lines.push(`${i + 1}. ${item.text}: ${item.commands.join(', ')}`));
  lines.push('');
  lines.push('Что дальше: нажмите кнопку или напишите команду. Все команды по группам: /help');
  return lines.join('\n');
}

export function guideKeyboard() {
  return Keyboard.inlineKeyboard([
    [btn('Проверить ставку', 'stavka'), btn('Мои вакансии', 'vacancies')],
    [btn('Найти работу', 'jobs')],
    [btn('Показать на примере', 'demo'), btn('Проверить штат', 'staff')],
  ]);
}

export function helpText(): string {
  return [
    guideText().replace(/\n\nЧто дальше:.*$/s, ''),
    '',
    'Команды по группам',
    '',
    'Основное:',
    '/stavka – сколько платить: должность, регион, ваша ставка. Покажу, где вы среди работодателей региона',
    '/staff – мой штат: кто получает меньше рынка и сколько стоит это исправить',
    '/vacancies – мои вакансии и отклики кандидатов',
    '/jobs – найти работу: каталог вакансий с откликом прямо в MAX',
    '/checks – плановые проверки на год по моему ИНН и региону',
    '',
    'Ещё:',
    '/regions – сравнить одну должность по нескольким регионам',
    '/digest – зарплаты по всему моему региону, сразу по десятку должностей',
    '/subs – мои подписки: напишу, когда рынок заметно сдвинется',
    '/demo – показать всё на готовом примере',
    '',
    'Настройки и справка:',
    '/profile – указать или сменить ИНН бизнеса (нужен для проверок и сравнения с похожими работодателями)',
    '/help – эта справка',
    '',
    'Должность можно не выбирать кнопкой, а написать текстом, любую, даже редкую: подскажу похожие позиции из государственного справочника профессий (8 037 профессий) или посчитаю по вашему названию.',
    '',
    'Как считаю: беру живые объявления портала «Работа России» по вашему региону, повторы одного работодателя считаю один раз, затем смотрю, сколько платит большинство и где среди них ваша ставка. Размер каждого работодателя узнаю в реестре МСП ФНС по ИНН. Плановые проверки беру из открытого реестра Генпрокуратуры. Ничего не придумываю: каждое число можно проверить по источнику.',
    '',
    'Что дальше: нажмите кнопку ниже или напишите команду.',
  ].join('\n');
}

/* ---------- шаги /stavka ---------- */

export function askInnText(): string {
  return [
    'Шаг 1 из 3: ваш бизнес.',
    'Напишите ИНН компании или ИП. По нему узнаю регион, отрасль и размер бизнеса и буду сравнивать вас с похожими работодателями, а не со всем рынком.',
    'Дальше: шаг 2 – должность, шаг 3 – ваша ставка. Всё займёт минуту.',
    '',
    'Что дальше: напишите ИНН (10 или 12 цифр) или нажмите «Без ИНН, укажу регион».',
  ].join('\n');
}

/** ИНН необязателен: выход со шага одной кнопкой, а не словом «пропустить». */
export function askInnKeyboard() {
  return Keyboard.inlineKeyboard([[btn('Без ИНН, укажу регион', 'inn:skip')]]);
}

export function askRegionText(reason: 'skip' | 'first' = 'skip'): string {
  return [
    reason === 'skip' ? 'Хорошо, без ИНН. Шаг 1 из 3: регион.' : 'Сначала регион, это шаг 1 из 3.',
    'Напишите регион, где нанимаете, например «Санкт-Петербург» или «Татарстан». Сравню со всеми работодателями региона.',
    'Дальше: шаг 2 – должность, шаг 3 – ваша ставка.',
    '',
    'Что дальше: напишите название региона. Если хотите сравнение с похожими работодателями, укажите ИНН кнопкой.',
  ].join('\n');
}

export function askRegionKeyboard() {
  return Keyboard.inlineKeyboard([[btn('Указать ИНН', 'inn:new')]]);
}

/** checksLine – строка «Проверки {год}: …» из плана ЕРКНМ; null, если набор ещё не загружен. */
export function profileText(p: BusinessProfile, pack: Pack, regionName: string | null, checksLine: string | null = null): string {
  if (!p.inRegistry) {
    return [
      `ИНН ${p.inn} в реестре малого бизнеса (реестр МСП ФНС) не найден. Так бывает с бюджетными организациями, крупным бизнесом или после ликвидации. Продолжим без профиля.`,
      '',
      'Что дальше: напишите регион, например «Санкт-Петербург».',
    ].join('\n');
  }
  const lines = [
    `Нашёл ваш бизнес в реестре малого бизнеса (реестр МСП ФНС, данные на ${fmtDate(p.fetchedAt)}):`,
    `• ${p.name || 'Бизнес'}${p.kind === 'IP' ? ' (ИП)' : ''}`,
    `• Размер: ${sizeLabel(p.category)}${p.active === false ? '; исключён из реестра' : ''}`,
    `• Вид деятельности: ${p.okvedName ? `${p.okvedName} (код ${p.okved ?? 'не указан'})` : `код ${p.okved ?? 'не указан'}`}`,
    `• Регион: ${regionName ?? p.fnsRegionCode ?? 'не определён'}`,
    `• Отрасль: ${pack.title}`,
    ...(checksLine ? [`• ${checksLine}`] : []),
    '',
    'Буду сравнивать вас с работодателями такого же размера в вашем регионе: это честнее, чем со всем рынком.',
    '',
    'Что дальше: если всё верно, нажмите «Верно, дальше» – перейдём к шагу 2 из 3, выбору должности. Ошибся – нажмите «Другой ИНН».',
  ];
  return lines.join('\n');
}

export function profileKeyboard() {
  return Keyboard.inlineKeyboard([[btn('Верно, дальше', 'profile:ok'), btn('Другой ИНН', 'inn:new')]]);
}

/** Короткие названия регионов для узких кнопок: полное имя субъекта в ряд не влезает. */
const SHORT_REGION: Record<string, string> = { '78': 'СПб', '77': 'Москва', '16': 'Татарстан', '23': 'Краснодар', '66': 'Свердловская', '54': 'Новосибирск' };

/** Подпись пакета для кнопки: «АПК · сезонные работы (Краснодарский край)» → «АПК · Краснодар». */
export function packShortTitle(pack: Pack): string {
  const head = (pack.title.split('·')[0] ?? pack.title).trim();
  const region = pack.region ? SHORT_REGION[pack.region.fnsCode] ?? pack.region.name : null;
  return fitLabel(region ? `${head} · ${region}` : head);
}

export function askProfessionText(pack: Pack): string {
  return [
    'Шаг 2 из 3: должность.',
    `Кого нанимаете? Нажмите кнопку с должностью из отрасли «${pack.title}» или напишите её текстом – подойдёт любая, даже редкая.`,
    'Дальше: шаг 3 – ваша ставка, и сразу покажу карточку рынка.',
  ].join('\n');
}

export function professionKeyboard(pack: Pack) {
  const rows: KeyboardRows = [];
  const list = pack.professions.slice(0, 14);
  for (let i = 0; i < list.length; i += 2) {
    rows.push(list.slice(i, i + 2).map((p) => btn(p.title, `prof:${p.key}`)));
  }
  return Keyboard.inlineKeyboard(rows);
}

export function askSalaryText(professionTitle: string): string {
  return [
    'Шаг 3 из 3: ваша ставка.',
    `Сколько планируете платить за должность «${professionTitle}»? Напишите оклад в месяц до вычета НДФЛ, например 45000.`,
    'Если ставки ещё нет, нажмите «Пока без ставки»: покажу рынок без сравнения.',
    'Дальше: карточка рынка, где ваша ставка среди работодателей региона и что написать в вакансии.',
  ].join('\n');
}

export function askSalaryKeyboard() {
  return Keyboard.inlineKeyboard([[btn('Пока без ставки', 'salary:none')]]);
}

/* ---------- карточка рынка ---------- */

/** Подпись варианта ставки: одна и та же в боте и в итогах голосования. */
export const OPTION_LABEL: Record<string, string> = { keep: 'оставить свою', median: 'обычная ставка рынка', top: 'выше трёх четвертей рынка' };
/** Короткая подпись для кнопки голосования: целиком в ряд из трёх кнопок не влезает. */
const OPTION_SHORT: Record<string, string> = { keep: 'моя', median: 'обычная', top: 'верхняя' };
/** Что даст каждый вариант, простыми словами. */
const OPTION_EXPLAIN: Record<string, string> = {
  keep: 'оставить свою ставку как есть',
  median: 'обычная ставка рынка (медиана): половина работодателей платит меньше, половина больше',
  top: 'больше, чем у трёх четвертей работодателей (верхняя четверть): так вы обгоняете большинство конкурентов',
};

/**
 * Ставка, по которой уйдёт публикация: обычная ставка рынка, иначе своя ставка.
 * Та же формула, что в publishVacancy, иначе подпись кнопки разошлась бы с делом.
 */
export function publishSalary(r: MarketResult): number | null {
  return r.card.offer?.value ?? r.card.options.find((o) => o.kind === 'median')?.value ?? r.card.stats?.median ?? null;
}

/** Вывод одной фразой про ставку владельца. */
function offerLead(offer: NonNullable<MarketCard['offer']>, professionTitle: string): string {
  const lead = BAND_PLAIN[offer.band].replace(/^вы/, 'Вы');
  if (offer.band === 'above') return `${lead}: только ${offer.shareAbove} из 100 работодателей региона предлагают на должность «${professionTitle}» больше ваших ${formatRub(offer.value)}.`;
  return `${lead}: ${offer.shareAbove} из 100 работодателей региона предлагают на должность «${professionTitle}» больше ваших ${formatRub(offer.value)}.`;
}

/** Где ставка относительно коридора половины вакансий. */
function corridorNote(offer: number, p25: number, p75: number): string {
  if (offer < p25) return 'Ваша ставка ниже этого коридора: вы платите заметно меньше рынка.';
  if (offer > p75) return 'Ваша ставка выше этого коридора: вы платите больше рынка.';
  return 'Ваша ставка внутри коридора: вы платите как большинство.';
}

/** «Что это значит для вас» по диапазону ставки. */
function meaningLine(card: MarketCard): string {
  const stats = card.stats!;
  const median = card.options.find((o) => o.kind === 'median');
  const top = card.options.find((o) => o.kind === 'top');
  if (!card.offer) {
    return `чтобы нанимать без долгих поисков, ориентируйтесь на ${formatRub(stats.median)} и выше. ${formatRub(stats.p75)} и больше платит только четверть работодателей.`;
  }
  const band: OfferBand = card.offer.band;
  const upgrade = median && top ? ` С ${formatRub(median.value)} вы окажетесь в верхней половине рынка, с ${formatRub(top.value)} будете платить больше, чем три четверти работодателей.` : '';
  if (band === 'low') return `за ${formatRub(card.offer.value)} кандидаты будут выбирать конкурентов, большинство платит больше.${upgrade}`;
  if (band === 'below_median') return `ставка чуть ниже обычной, часть кандидатов уйдёт к тем, кто платит ${formatRub(stats.median)} и больше.${upgrade}`;
  if (band === 'market') return `вы платите как большинство.${top ? ` Чтобы обгонять три четверти конкурентов, нужно от ${formatRub(top.value)}.` : ''}`;
  return 'ставка уже конкурентна, дальше решают условия работы и скорость ответа кандидатам.';
}

/** Сколько объявлений посчитали и почему меньше, чем нашлось. */
export function sampleLine(card: MarketCard, total: number): string {
  const rest = Math.max(0, total - card.sample.vacancies);
  const reasons = Object.entries(card.sample.dropped)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => DROPPED_LABEL[k] ?? k);
  const head = `Посчитано по ${card.sample.vacancies} ${pluralRu(card.sample.vacancies, 'объявлению', 'объявлениям', 'объявлениям')} ${card.sample.employers} ${employersWord(card.sample.employers)}.`;
  if (!rest) return head;
  return `${head} Ещё ${rest} ${vacanciesWord(rest)} не подошли: ${reasons.length ? reasons.slice(0, 4).join(', ') : 'без зарплаты, повторы или другая должность'}.`;
}

export function cardText(r: MarketResult): string {
  const { card, profession, region } = r;
  const lines: string[] = [];
  lines.push(`📊 ${profession.title} – ${region.name}`);
  lines.push('');
  if (card.confidence === 'none' || !card.stats) {
    lines.push(card.verdict);
    lines.push('');
    lines.push('Что дальше:');
    lines.push('1) Нажмите «Другая должность» и попробуйте другое название, например без уточнений.');
    lines.push('2) Посмотрите соседний регион: /regions.');
    lines.push('3) Посмотрите весь рынок региона по десятку должностей: /digest.');
    lines.push('');
    lines.push(sourceLine(r.fetched.fetchedAt));
    return lines.join('\n');
  }
  const s = card.stats;
  const offer = card.offer;

  // 1. Вывод одной фразой.
  lines.push(offer
    ? offerLead(offer, profession.title)
    : `Обычная ставка «${profession.title.toLowerCase()}» в регионе – ${formatRub(s.median)}: половина работодателей платит меньше, половина больше.`);
  lines.push('');

  // 2. Числа с объяснением.
  if (offer) lines.push(`Ваша ставка: ${formatRub(offer.value)}. Только ${offer.percentile} из 100 работодателей платят меньше (${offer.percentile}-й перцентиль).`);
  lines.push(`Обычная ставка рынка: ${formatRub(s.median)} (медиана). Половина работодателей платит меньше этой суммы, половина больше.`);
  lines.push(`Коридор половины вакансий: ${formatRub(s.p25)}–${formatRub(s.p75)}. ${offer ? corridorNote(offer.value, s.p25, s.p75) : 'Ниже коридора платят заметно меньше рынка, выше – больше.'}`);
  if (card.sameSize && card.sameSize.median != null && card.sameSize.employers >= 3) {
    const same = card.sameSize;
    const cmp = same.median! > s.median ? 'больше, чем рынок в целом' : same.median! < s.median ? 'меньше, чем рынок в целом' : 'столько же, сколько рынок в целом';
    lines.push(`Работодатели вашего размера (${sizeLabel(same.category)}) платят ${formatRub(same.median!)} – ${cmp}. Посчитано по ${same.employers} ${pluralRu(same.employers, 'работодателю', 'работодателям', 'работодателям')}; сравнение с ними честнее, чем со всем рынком.`);
  }
  if (card.confidence === 'low') lines.push(`⚠️ ${card.confidenceReason}. Это слишком мало для вывода: цифры выше – ориентир. Посмотрите соседний регион или похожую должность.`);
  lines.push('');

  // 3. Что это значит для вас.
  lines.push(`Что это значит для вас: ${meaningLine(card)}`);
  if (card.options.length > 1) {
    lines.push('');
    lines.push('Варианты ставки:');
    for (const o of card.options) lines.push(`• ${formatRub(o.value)} – ${OPTION_EXPLAIN[o.kind] ?? o.label}.`);
  }
  if (card.requirements.length) {
    lines.push('');
    lines.push(`В объявлениях чаще всего просят: ${card.requirements.slice(0, 4).map((x) => `${x.label} (в ${x.share} % объявлений)`).join(', ')}.`);
  }
  lines.push('');

  // 4. Что дальше.
  const next: string[] = [];
  next.push('Выберите сумму кнопкой ниже или нажмите «Своя зарплата»: это зарплата будущей вакансии.');
  next.push('Проверьте текст и условия. Вакансия появится только после кнопки «Подтвердить публикацию».');
  next.push('«Подробный разбор» и PDF – необязательно, если нужны детали расчёта.');
  lines.push('Что дальше:');
  next.forEach((x, i) => lines.push(`${i + 1}) ${x}`));
  lines.push('');

  // 5. Источник и дата.
  lines.push(sampleLine(card, r.fetched.total));
  lines.push(sourceLine(r.fetched.fetchedAt));
  return lines.join('\n');
}

export function cardKeyboard(r: MarketResult, botUsername: string) {
  const rows: KeyboardRows = [];
  const salary = publishSalary(r);
  rows.push([openRadarButton(botUsername, r.cardId)]);
  if (r.card.options.length > 1) {
    rows.push(r.card.options.map((o) => { const w = OPTION_SHORT[o.kind] ?? o.kind; return btn(`${w.charAt(0).toUpperCase()}${w.slice(1)}: ${thousands(o.value)}`, `choose:${o.kind}:${r.cardId}`); }));
  }
  rows.push([btn('Прислать PDF-отчёт', `pdf:${r.cardId}`), btn('Следить за рынком', `sub:${r.cardId}`)]);
  rows.push([btn('Своя зарплата', `custom:${r.cardId}`), btn('Другая должность', 'prof:again')]);
  rows.push([btn('Создать вакансию', `pub:${r.cardId}`)]);
  return Keyboard.inlineKeyboard(rows);
}

/** Черновик объявления из карточки: текст плюс кнопки следующего шага. */
export function draftText(text: string): string {
  return [
    'Черновик вакансии. Это шаблон: проверьте график и условия перед публикацией.',
    '',
    text,
    '',
    'Что дальше: нажмите «Создать вакансию», выберите зарплату и подтвердите условия. Этот текст ещё не опубликован.',
  ].join('\n');
}

export function draftKeyboard(r: MarketResult, botUsername: string) {
  const salary = publishSalary(r);
  return Keyboard.inlineKeyboard([
    [btn('Создать вакансию', `pub:${r.cardId}`)],
    [openRadarButton(botUsername, r.cardId), btn('Другая должность', 'prof:again')],
  ]);
}

export function publicationSalaryText(r: MarketResult): string {
  return `Зарплата вакансии «${r.profession.title}»\n\nНапишите свою сумму в рублях в месяц до НДФЛ, например 75000, или выберите вариант. Рыночная зарплата – ориентир, а не ограничение.\n\nПосле выбора покажу черновик. Пока ничего не опубликовано.`;
}

export function publicationSalaryKeyboard(r: MarketResult) {
  return Keyboard.inlineKeyboard([
    ...r.card.options.map((o) => [btn(`${OPTION_SHORT[o.kind] ?? o.kind}: ${thousands(o.value)}`, `choose:${o.kind}:${r.cardId}`)]),
    [btn('Отменить', 'draftcancel')],
  ]);
}

export function publicationReviewText(salary: number, text: string, listed: boolean): string {
  return [
    `Проверьте вакансию: зарплата ${formatRub(salary)} в месяц до НДФЛ.`,
    listed ? 'Публикация в общем каталоге: объявление увидят все пользователи бота.' : 'Публикация только по ссылке: в общем каталоге объявления не будет.',
    '', text, '',
    'Проверьте график, место работы, обязанности и условия. Не обещайте льготы, которых нет. Нажимая «Подтвердить публикацию», вы подтверждаете правильность объявления.',
  ].join('\n');
}

export function publicationReviewKeyboard(cardId: string, listed: boolean) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Подтвердить публикацию', `pubconfirm:${cardId}`)],
    [btn('Изменить зарплату', `custom:${cardId}`), btn('Изменить текст', `draftedit:${cardId}`)],
    [btn(listed ? 'Убрать из каталога' : 'Добавить в каталог', `draftlist:${cardId}`)],
    [btn('Отменить', 'draftcancel')],
  ]);
}

/** Итог голосования под карточкой. */
export function voteText(professionTitle: string, chosen: { kind: string; value: number } | null, options: { kind: string; value: number }[], counts: Record<string, number>, total: number): string {
  const summary = options.map((o) => `${OPTION_LABEL[o.kind] ?? o.kind} ${formatRub(o.value)} – ${counts[o.kind] ?? 0}`).join('; ');
  return [
    `Учёл ваш голос${chosen ? `: ${OPTION_LABEL[chosen.kind] ?? chosen.kind}, ${formatRub(chosen.value)}` : ''}.`,
    `Итог по «${professionTitle}»: ${summary}. Всего голосов: ${total}.`,
    '',
    'Что дальше: когда команда определилась, нажмите «Опубликовать» под карточкой или «Текст вакансии».',
  ].join('\n');
}

export function subscribedText(professionTitle: string, regionName: string): string {
  return [
    `Слежу за рынком «${professionTitle}, ${regionName}». Раз в неделю пересчитаю и напишу, если обычная ставка сдвинется больше чем на 5 %.`,
    '',
    'Что дальше: ничего делать не нужно, сообщение придёт сюда. Отписаться: /subs',
  ].join('\n');
}

/* ---------- отклики и найм ---------- */

/** Карточка опубликованной вакансии в чате работодателя: ссылка, QR и действия. */
export function publishedVacancyText(v: VacancyRow, regionName: string, link: string): string {
  return [
    `✅ Вакансия опубликована: ${v.title} – ${regionName}`,
    v.salary ? `Ставка: от ${formatRub(v.salary)}` : 'Ставка: не указана',
    '',
    'Ссылка для кандидатов:',
    link,
    '',
    'Что дальше:',
    '1) Перешлите ссылку в чаты сотрудников, партнёров и местные каналы MAX: кнопка «Поделиться в MAX». QR можно распечатать для зала.',
    '2) Кандидат откроет бота по ссылке, ответит на три вопроса и сможет поделиться номером. Отклики придут сюда и в раздел «Вакансии и отклики».',
    '3) Когда нашли человека, нажмите «Закрыть вакансию».',
    v.listed ? 'Вакансия видна в общем каталоге /jobs.' : 'Пока вакансия доступна только по ссылке. «В общий каталог» сделает её видимой всем пользователям бота.',
  ].join('\n');
}

export function publishedVacancyKeyboard(v: VacancyRow, botUsername: string, link: string) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.link('Поделиться в MAX', link)],
    [inboxButton(botUsername, v.id), btn('Закрыть вакансию', `vacclose:${v.id}`)],
    [btn('В общий каталог', `listjob:${v.id}`)],
  ]);
}

/** Карточка вакансии для кандидата, пришедшего по диплинку. */
export function candidateVacancyText(v: VacancyRow, regionName: string): string {
  const lines = [
    `📌 ${v.title} – ${regionName}`,
    v.employerName ? `Работодатель: ${v.employerName}` : null,
    v.salary ? `Ставка: от ${formatRub(v.salary)}` : null,
    '',
    v.text,
  ].filter((x): x is string => x !== null);
  if (v.status === 'closed') lines.push('', '⚠️ Вакансия уже закрыта, откликнуться нельзя.', '', 'Что дальше: посмотрите, сколько платят по вашей должности в регионе, кнопка ниже.');
  else lines.push('', 'Что дальше: нажмите «Откликнуться». Задам три коротких вопроса, это займёт минуту, и работодатель получит ваш отклик.');
  return lines.join('\n');
}

export function candidateVacancyKeyboard(v: VacancyRow) {
  if (v.status === 'closed') return Keyboard.inlineKeyboard([[btn('Другие вакансии', 'jobs')]]);
  return Keyboard.inlineKeyboard([[btn('Откликнуться', `apply:${v.id}`)], [btn('Другие вакансии', 'jobs')]]);
}

export const askExperienceText = [
  'Вопрос 1 из 3. Какой у вас опыт по этой должности?',
  'Дальше спрошу про график и ожидания по зарплате.',
  '',
  'Что дальше: нажмите подходящую кнопку.',
].join('\n');

export function experienceKeyboard(vacancyId: string) {
  return Keyboard.inlineKeyboard([
    [btn('Без опыта', `exp:none:${vacancyId}`), btn('До года', `exp:lt1:${vacancyId}`)],
    [btn('1–3 года', `exp:mid:${vacancyId}`), btn('3 года и больше', `exp:senior:${vacancyId}`)],
  ]);
}

export function askScheduleText(v: VacancyRow): string {
  const line = /^График:\s*(.+)$/m.exec(v.text)?.[1];
  return [
    `Вопрос 2 из 3. Готовы работать по графику вакансии${line ? ` (${line})` : ''}?`,
    'Остался один вопрос: ожидания по зарплате.',
    '',
    'Что дальше: нажмите «Да, готов» или «Нет».',
  ].join('\n');
}

export function scheduleKeyboard(vacancyId: string) {
  return Keyboard.inlineKeyboard([[btn('Да, готов', `sch:yes:${vacancyId}`), btn('Нет', `sch:no:${vacancyId}`)]]);
}

export function askSalaryExpectationText(v: VacancyRow): string {
  return [
    `Вопрос 3 из 3. На какую ставку рассчитываете?${v.salary ? ` В вакансии от ${formatRub(v.salary)}.` : ''}`,
    '',
    'Что дальше: напишите число в рублях в месяц, например 60000, или нажмите «Как в вакансии».',
  ].join('\n');
}

export function salaryExpectationKeyboard(vacancyId: string) {
  return Keyboard.inlineKeyboard([[btn('Как в вакансии', `expsal:asis:${vacancyId}`)]]);
}

export const askPhoneText = [
  'Вопросы закончились, остался последний шаг.',
  'Поделитесь номером телефона, чтобы работодатель мог позвонить. Номер увидит только он; подлинность номера проверяет сервер MAX.',
  '',
  'Что дальше: нажмите «Поделиться номером» или «Без номера», тогда работодатель ответит сообщением здесь.',
].join('\n');

export function phoneKeyboard(vacancyId: string) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.requestContact('Поделиться номером')],
    [btn('Без номера', `nophone:${vacancyId}`)],
  ]);
}

export function responseSentText(withPhone: boolean, notified = true): string {
  return [
    notified ? 'Отклик сохранён, работодателю отправлено сообщение в MAX.' : 'Отклик сохранён в разделе работодателя, но уведомление в MAX сейчас не отправилось.',
    withPhone ? 'Номер сохранён в отклике и доступен работодателю, он может позвонить.' : 'Номер вы не оставили: работодатель сможет ответить сообщением в MAX.',
    '',
    'Что дальше: ждите ответа здесь, в этом чате. Приглашение, отказ или приём на работу придут сообщением. Пока ждёте, можно посмотреть, сколько платят по вашей должности в регионе.',
  ].join('\n');
}

export function responseSentKeyboard() {
  return Keyboard.inlineKeyboard([[btn('Ставки по рынку', 'stavka')]]);
}

/** Список вакансий работодателя: /vacancies. Нумерация совпадает с кнопками. */
export function vacanciesListText(items: { title: string; responses: number; newResponses: number; status: string }[]): string {
  if (!items.length) {
    return [
      'Опубликованных вакансий пока нет.',
      '',
      'Что дальше: проверьте ставку (/stavka) и нажмите «Опубликовать» под карточкой: получите ссылку и QR для кандидатов, отклики придут сюда.',
    ].join('\n');
  }
  const lines = [`Ваши вакансии (${items.length}):`];
  items.forEach((v, i) => {
    lines.push(`${i + 1}. ${v.title} – ${v.status === 'open' ? 'открыта' : 'закрыта'}, откликов ${v.responses}${v.newResponses ? ` (новых ${v.newResponses})` : ''}`);
  });
  lines.push('');
  lines.push('Что дальше: нажмите номер вакансии, чтобы открыть отклики: там можно пригласить на собеседование, отказать или принять на работу.');
  return lines.join('\n');
}

export function vacanciesKeyboard(botUsername: string, items: { id: string; title: string }[]) {
  const rows: KeyboardRows = items.slice(0, 8).map((v, i) => [inboxButton(botUsername, v.id, fitLabel(`${i + 1}. ${v.title}`))]);
  rows.push([btn('Проверить ставку', 'stavka')]);
  return Keyboard.inlineKeyboard(rows);
}

/** Подписки: /subs. Нумерация совпадает с кнопками «Отписаться». */
export function subsText(items: { title: string }[]): string {
  if (!items.length) {
    return [
      'Подписок пока нет.',
      '',
      'Что дальше: проверьте ставку (/stavka) и нажмите «Следить за рынком» под карточкой: раз в неделю пересчитаю и напишу, если обычная ставка сдвинется больше чем на 5 %.',
    ].join('\n');
  }
  const lines = [`Ваши подписки (${items.length}). Раз в неделю сравниваю обычную ставку рынка и пишу, если она сдвинулась больше чем на 5 %:`];
  items.forEach((s, i) => lines.push(`${i + 1}. ${s.title}`));
  lines.push('');
  lines.push('Что дальше: чтобы отписаться, нажмите кнопку с номером подписки.');
  return lines.join('\n');
}

export function subsKeyboard(items: { id: string; title: string }[]) {
  const rows: KeyboardRows = items.map((s, i) => [btn(`Отписаться: ${i + 1}. ${s.title}`, `unsub:${s.id}`)]);
  rows.push([btn('Проверить ставку', 'stavka')]);
  return Keyboard.inlineKeyboard(rows);
}

/* ---------- свободный ввод должности ---------- */

/** Текст с подсказками, когда должности нет в каталоге: выбор из справочника или расчёт «как есть». */
export function professionSuggestText(query: string, suggestions: { title: string; source: 'catalog' | 'okpdtr' }[]): string {
  const lines = [`Должности «${query.slice(0, 80)}» нет в моём списке должностей.`];
  if (suggestions.length) {
    lines.push('Нашёл похожие в государственном справочнике профессий:');
    suggestions.forEach((s, i) => lines.push(`${i + 1}. ${s.title}`));
    lines.push('');
    lines.push('Что дальше: нажмите номер подходящего варианта или «По моему названию», тогда поищу объявления по вашему тексту.');
  } else {
    lines.push('Посчитаю по вашему названию: объявления найду по этому же тексту.');
    lines.push('');
    lines.push('Что дальше: нажмите «По моему названию» или выберите должность из списка.');
  }
  return lines.join('\n');
}

export function professionSuggestKeyboard(own: { key: string; title: string }, suggestions: { key: string; title: string }[]) {
  const rows: KeyboardRows = [];
  if (suggestions.length) rows.push(suggestions.map((sug, i) => btn(`Вариант ${i + 1}`, `prof:${sug.key}`)));
  rows.push([btn('По моему названию', `prof:${own.key}`), btn('Выбрать из списка', 'prof:again')]);
  return Keyboard.inlineKeyboard(rows);
}

/* ---------- штат ---------- */

export function staffIntroText(regionName: string | null): string {
  return [
    `Проверю ваш штат против рынка${regionName ? ` (${regionName})` : ''}: кто из сотрудников получает меньше рынка и сколько стоит это исправить.`,
    '',
    'Как вводить: по строке на человека, должность и ставка в месяц. Можно одним списком или несколькими сообщениями. Например:',
    'повар 60000',
    'официант 45000',
    'администратор 70 тыс',
    '',
    'Что дальше: пришлите строки. Когда закончите, нажмите «Посчитать» или напишите «готово». Передумали – «Отменить».',
  ].join('\n');
}

export function staffAddedText(added: number, total: number, skipped: string[]): string {
  const lines = [`Записал ${added} ${pluralRu(added, 'строку', 'строки', 'строк')}, всего в списке ${total}.`];
  if (skipped.length) lines.push(`Не разобрал: ${skipped.slice(0, 3).map((x) => `«${x}»`).join(', ')}. Нужна строка вида «повар 60000».`);
  lines.push('');
  lines.push('Что дальше: добавьте ещё строки или нажмите «Посчитать».');
  return lines.join('\n');
}

/** Кнопки на шаге ввода штата: посчитать или отменить без лишних слов. */
export function staffInputKeyboard() {
  return Keyboard.inlineKeyboard([[btn('Посчитать', 'staff:done'), btn('Отменить', 'staff:cancel')]]);
}

export function staffKeyboard(botUsername: string) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.openApp('Мой штат в приложении', botUsername, undefined, 'staff')],
    [btn('Проверить ставку', 'stavka'), btn('Что умеет бот', 'guide')],
  ]);
}

/* ---------- сравнение регионов ---------- */

export function askRegionsText(professionTitle: string, limit: number): string {
  return [
    'Сравнение регионов, шаг 2 из 2: регионы.',
    `Сравню «${professionTitle}» по регионам: где люди дешевле и где их больше.`,
    '',
    `Что дальше: напишите до ${limit} регионов через запятую, например «СПб, Татарстан, Москва».`,
  ].join('\n');
}

export const askRegionsProfessionText = [
  'Сравнение регионов, шаг 1 из 2: должность.',
  'По какой должности сравнить регионы? Напишите название, например «повар» или «обвальщик мяса».',
  'Дальше: шаг 2 – список регионов.',
].join('\n');

export function regionsKeyboard(botUsername: string) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.openApp('Регионы в приложении', botUsername, undefined, 'regions')],
    [btn('Проверить ставку', 'stavka'), btn('Что умеет бот', 'guide')],
  ]);
}

/* ---------- сводка по региону ---------- */

export function digestKeyboard(botUsername: string) {
  return Keyboard.inlineKeyboard([
    [openRadarButton(botUsername, null, 'Открыть приложение')],
    [btn('Проверить ставку', 'stavka'), btn('Сравнить регионы', 'regions')],
  ]);
}

/* ---------- проверки ---------- */

export function checksKeyboard(botUsername: string, hasInn: boolean) {
  return Keyboard.inlineKeyboard([
    [openRadarButton(botUsername, null, 'Открыть приложение'), btn(hasInn ? 'Сменить ИНН' : 'Указать ИНН', 'inn:new')],
    [btn('Проверить ставку', 'stavka'), btn('Что умеет бот', 'guide')],
  ]);
}

/* ---------- демо ---------- */

export function demoChoiceText(): string {
  return [
    'Покажу на готовом примере: это реальные микропредприятия из реестра МСП, чужой бизнес. Ваш профиль не меняется.',
    '',
    'Что дальше: выберите пример кнопкой.',
  ].join('\n');
}

export function demoIntroText(note: string, professionTitle: string, salary: number): string {
  return [
    `Пример: ${note.replace(/\u2014/g, '–')}.`,
    `Должность «${professionTitle}», ставка ${formatRub(salary)}. Ваш профиль не меняется.`,
    '',
    'Что дальше: сейчас посчитаю карточку рынка, как для настоящего запроса.',
  ].join('\n');
}

/** Ответ на непонятную реплику вне сценария. */
export function fallbackText(): string {
  return [
    'Не понял, что сделать.',
    '',
    'Что дальше: нажмите «Проверить ставку» или посмотрите, что умеет бот. Справка: /help',
  ].join('\n');
}
