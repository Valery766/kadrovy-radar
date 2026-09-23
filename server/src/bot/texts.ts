/** Тексты и клавиатуры бота. Всё детерминированно: числа берутся из карточки ядра. */
import { Keyboard } from '@maxhub/max-bot-api';

type KeyboardRows = Parameters<typeof Keyboard.inlineKeyboard>[0];
import { BAND_LABEL, categoryLabel, formatRub, pluralRu } from '../core/index.js';
import type { MarketResult } from '../services/market.js';
import type { BusinessProfile } from '../integrations/rmsp.js';
import type { Pack } from '../core/index.js';
import type { VacancyRow } from '../db/index.js';
import { openRadarButton } from '../services/report.js';
import { inboxButton } from '../services/hiring.js';

export const fmtDate = (iso: string) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function welcomeText(name: string | null): string {
  return [
    `${name ? `${name}, здравствуйте` : 'Здравствуйте'}! Я «Ставка» — зарплатный радар для малого бизнеса.`,
    '',
    'За минуту покажу, сколько платят за нужную должность в вашем регионе конкуренты вашего размера, где ваша ставка на шкале рынка и что написать в вакансии.',
    '',
    'Данные — только официальные: реестр МСП ФНС (профиль вашего бизнеса по ИНН) и портал «Работа России» (живые вакансии с зарплатами).',
    '',
    'С чего начнём?',
  ].join('\n');
}

export function welcomeKeyboard(botUsername: string) {
  return Keyboard.inlineKeyboard([
    [openRadarButton(botUsername, null)],
    [Keyboard.button.callback('Ввести ИНН', 'inn:new'), Keyboard.button.callback('Показать на примере', 'demo')],
  ]);
}

export function askInnText(): string {
  return 'Введите ИНН вашего бизнеса (10 цифр для организации, 12 — для ИП). По нему я возьму из реестра МСП регион, отрасль и размер компании — чтобы сравнивать вас с похожими работодателями.\n\nЕсли ИНН под рукой нет — напишите «пропустить», спрошу регион.';
}

/** checksLine — строка «Проверки {год}: …» из плана ЕРКНМ; null, если набор ещё не загружен. */
export function profileText(p: BusinessProfile, pack: Pack, regionName: string | null, checksLine: string | null = null): string {
  if (!p.inRegistry) {
    return `ИНН ${p.inn} в реестре МСП не найден — так бывает с бюджетными организациями, крупным бизнесом или после ликвидации. Продолжим без профиля: напишите регион (например, «Санкт-Петербург»).`;
  }
  const lines = [
    `Нашёл в реестре МСП (ФНС, получено ${fmtDate(p.fetchedAt)}):`,
    `• ${p.name || 'Бизнес'}${p.kind === 'IP' ? ' (ИП)' : ''}`,
    `• ${categoryLabel(p.category)}${p.active === false ? ', исключён из реестра' : ''}`,
    `• ОКВЭД ${p.okved ?? '—'}${p.okvedName ? ` — ${p.okvedName}` : ''}`,
    `• Регион: ${regionName ?? p.fnsRegionCode ?? '—'}`,
    `• Пакет контекста: ${pack.title}`,
    ...(checksLine ? [`• ${checksLine}`] : []),
    '',
    'Всё верно?',
  ];
  return lines.join('\n');
}

export function profileKeyboard() {
  return Keyboard.inlineKeyboard([[Keyboard.button.callback('Верно, дальше', 'profile:ok'), Keyboard.button.callback('Другой ИНН', 'inn:new')]]);
}

export function askProfessionText(pack: Pack): string {
  return `Кого нанимаете? Выберите должность из пакета «${pack.title}» или напишите её текстом.`;
}

export function professionKeyboard(pack: Pack) {
  const rows: KeyboardRows = [];
  const list = pack.professions.slice(0, 14);
  for (let i = 0; i < list.length; i += 2) {
    rows.push(list.slice(i, i + 2).map((p) => Keyboard.button.callback(p.title, `prof:${p.key}`)));
  }
  return Keyboard.inlineKeyboard(rows);
}

export function askSalaryText(professionTitle: string): string {
  return `Какую ставку планируете для должности «${professionTitle}»? Напишите оклад в месяц до вычета НДФЛ, например 45000.\n\nЕсли ставки ещё нет — напишите «нет», покажу рынок без сравнения.`;
}

export function cardText(r: MarketResult): string {
  const { card, profession, region } = r;
  const lines: string[] = [];
  lines.push(`📊 ${profession.title} — ${region.name}`);
  if (card.confidence === 'none' || !card.stats) {
    lines.push(card.verdict);
  } else {
    if (card.offer) {
      lines.push(`Ваши ${formatRub(card.offer.value)} — ${card.offer.percentile}-й перцентиль (${BAND_LABEL[card.offer.band]}): ${card.offer.shareAbove} % вакансий платят больше.`);
    }
    lines.push(`Медиана ${formatRub(card.stats.median)}, половина предложений — ${formatRub(card.stats.p25)}…${formatRub(card.stats.p75)}.`);
    if (card.sameSize && card.sameSize.median != null && card.sameSize.employers >= 3) {
      lines.push(`У работодателей вашего размера (${card.sameSize.label}): медиана ${formatRub(card.sameSize.median)}, ${card.sameSize.employers} ${pluralRu(card.sameSize.employers, 'работодатель', 'работодателя', 'работодателей')}.`);
    }
    if (card.confidence === 'low') lines.push(`⚠️ ${card.confidenceReason}. Цифры — ориентир, не вывод.`);
    if (card.requirements.length) lines.push(`Чаще всего требуют: ${card.requirements.slice(0, 4).map((x) => `${x.label} (${x.share} %)`).join(', ')}.`);
  }
  lines.push('');
  lines.push(`Выборка: ${card.sample.vacancies} ${pluralRu(card.sample.vacancies, 'вакансия', 'вакансии', 'вакансий')} от ${card.sample.employers} ${pluralRu(card.sample.employers, 'работодателя', 'работодателей', 'работодателей')} (из ${r.fetched.total} по запросу). Источник: «Работа России» · получено ${fmtDate(r.fetched.fetchedAt)}; размеры работодателей — реестр МСП ФНС.`);
  return lines.join('\n');
}

export function cardKeyboard(r: MarketResult, botUsername: string) {
  const rows: KeyboardRows = [];
  rows.push([openRadarButton(botUsername, r.cardId)]);
  if (r.card.options.length > 1) {
    rows.push(r.card.options.map((o) => Keyboard.button.callback(`${o.kind === 'keep' ? 'Оставить' : o.kind === 'median' ? 'Медиана' : 'Топ-25 %'} ${Math.round(o.value / 1000)} т.`, `vote:${o.kind}:${r.cardId}`)));
  }
  rows.push([Keyboard.button.callback('PDF-отчёт', `pdf:${r.cardId}`), Keyboard.button.callback('Следить за рынком', `sub:${r.cardId}`)]);
  rows.push([Keyboard.button.callback('Текст вакансии', `text:${r.cardId}`), Keyboard.button.callback('Другая должность', 'prof:again')]);
  rows.push([Keyboard.button.callback('Опубликовать вакансию', `pub:${r.cardId}`)]);
  return Keyboard.inlineKeyboard(rows);
}

/* ---------- отклики и найм ---------- */

/** Карточка опубликованной вакансии в чате работодателя: ссылка, QR и действия. */
export function publishedVacancyText(v: VacancyRow, regionName: string, link: string): string {
  return [
    `✅ Вакансия опубликована: ${v.title} — ${regionName}`,
    v.salary ? `Ставка: от ${formatRub(v.salary)}` : 'Ставка: не указана',
    '',
    'Ссылка для кандидатов (перешлите её в чаты сотрудников, партнёров и местные каналы MAX, распечатайте QR для зала):',
    link,
    '',
    'Кандидат откроет бота по ссылке, ответит на три вопроса и сможет поделиться номером. Отклики придут сюда и в мини-приложение.',
  ].join('\n');
}

export function publishedVacancyKeyboard(v: VacancyRow, botUsername: string, link: string) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.link('Поделиться в MAX', link)],
    [inboxButton(botUsername, v.id), Keyboard.button.callback('Закрыть вакансию', `vacclose:${v.id}`)],
  ]);
}

/** Карточка вакансии для кандидата, пришедшего по диплинку. */
export function candidateVacancyText(v: VacancyRow, regionName: string): string {
  const lines = [
    `📌 ${v.title} — ${regionName}`,
    v.employerName ? `Работодатель: ${v.employerName}` : null,
    v.salary ? `Ставка: от ${formatRub(v.salary)}` : null,
    '',
    v.text,
  ].filter((x): x is string => x !== null);
  if (v.status === 'closed') lines.push('', '⚠️ Вакансия уже закрыта — откликнуться нельзя.');
  return lines.join('\n');
}

export function candidateVacancyKeyboard(v: VacancyRow) {
  if (v.status === 'closed') return Keyboard.inlineKeyboard([[Keyboard.button.callback('Посмотреть ставки по рынку', 'prof:again')]]);
  return Keyboard.inlineKeyboard([[Keyboard.button.callback('Откликнуться', `apply:${v.id}`)]]);
}

export const askExperienceText = 'Вопрос 1 из 3. Какой у вас опыт по этой должности?';

export function experienceKeyboard(vacancyId: string) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Без опыта', `exp:none:${vacancyId}`), Keyboard.button.callback('До года', `exp:lt1:${vacancyId}`)],
    [Keyboard.button.callback('1–3 года', `exp:mid:${vacancyId}`), Keyboard.button.callback('3 года и больше', `exp:senior:${vacancyId}`)],
  ]);
}

export function askScheduleText(v: VacancyRow): string {
  const line = /^График:\s*(.+)$/m.exec(v.text)?.[1];
  return `Вопрос 2 из 3. Готовы работать по графику вакансии${line ? ` (${line})` : ''}?`;
}

export function scheduleKeyboard(vacancyId: string) {
  return Keyboard.inlineKeyboard([[Keyboard.button.callback('Да, готов', `sch:yes:${vacancyId}`), Keyboard.button.callback('Нет', `sch:no:${vacancyId}`)]]);
}

export function askSalaryExpectationText(v: VacancyRow): string {
  return `Вопрос 3 из 3. На какую ставку рассчитываете? Напишите число в рублях в месяц${v.salary ? ` (в вакансии — от ${formatRub(v.salary)})` : ''} или «как в вакансии».`;
}

export const askPhoneText = 'Остался последний шаг. Поделитесь номером телефона — работодатель свяжется с вами напрямую. Номер увидит только он, подпись MAX проверяется на сервере.';

export function phoneKeyboard(vacancyId: string) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.requestContact('Поделиться номером')],
    [Keyboard.button.callback('Без номера', `nophone:${vacancyId}`)],
  ]);
}

export function responseSentText(withPhone: boolean): string {
  return [
    'Отклик отправлен работодателю. Статус придёт сюда же, в этот чат.',
    withPhone ? 'Номер передан работодателю.' : 'Номер вы не оставили — работодатель ответит сообщением в MAX.',
  ].join(' ');
}

/** Список вакансий работодателя: /vacancies. */
export function vacanciesListText(items: { title: string; responses: number; newResponses: number; status: string }[]): string {
  if (!items.length) return 'Опубликованных вакансий пока нет. Получите карточку рынка (/stavka) и нажмите «Опубликовать вакансию».';
  const lines = [`Ваши вакансии (${items.length}):`];
  for (const v of items) {
    lines.push(`• ${v.title} — ${v.status === 'open' ? 'открыта' : 'закрыта'}, откликов ${v.responses}${v.newResponses ? ` (новых ${v.newResponses})` : ''}`);
  }
  return lines.join('\n');
}

/* ---------- свободный ввод должности ---------- */

/** Текст с подсказками, когда должности нет в каталоге: выбор из справочника или расчёт «как есть». */
export function professionSuggestText(query: string, suggestions: { title: string; source: 'catalog' | 'okpdtr' }[]): string {
  const lines = [`Должности «${query}» нет в каталоге пакета.`];
  if (suggestions.length) {
    lines.push('Похоже на справочник профессий ОКПДТР «Работы России» — выберите готовую позицию или считайте по своему названию:');
  } else {
    lines.push('Посчитаю по вашему названию — вакансии найду по этому же тексту.');
  }
  return lines.join('\n');
}

export function professionSuggestKeyboard(own: { key: string; title: string }, suggestions: { key: string; title: string }[]) {
  const rows: KeyboardRows = suggestions.map((sug) => [Keyboard.button.callback(sug.title.slice(0, 60), `prof:${sug.key}`)]);
  rows.push([Keyboard.button.callback(`Считать по «${own.title}»`.slice(0, 60), `prof:${own.key}`)]);
  rows.push([Keyboard.button.callback('Выбрать из списка', 'prof:again')]);
  return Keyboard.inlineKeyboard(rows);
}

/* ---------- штат ---------- */

export function staffIntroText(regionName: string | null): string {
  return [
    `Оценю ваш штат против рынка${regionName ? ` (${regionName})` : ''}: кто уже ниже медианы и сколько стоит подтянуть.`,
    '',
    'Пришлите должности со ставками — по строке на человека, можно несколькими сообщениями или одним списком:',
    'повар 60000',
    'официант 45000',
    'администратор 70 тыс',
    '',
    'Когда закончите — напишите «готово». Отменить — «отмена».',
  ].join('\n');
}

export function staffAddedText(added: number, total: number, skipped: string[]): string {
  const lines = [`Записал ${added} ${pluralRu(added, 'строку', 'строки', 'строк')}, всего в списке ${total}.`];
  if (skipped.length) lines.push(`Не разобрал: ${skipped.slice(0, 3).map((x) => `«${x}»`).join(', ')} — нужна строка вида «повар 60000».`);
  lines.push('Добавьте ещё или напишите «готово».');
  return lines.join('\n');
}

export function staffKeyboard(botUsername: string) {
  return Keyboard.inlineKeyboard([[Keyboard.button.openApp('Открыть «Мой штат»', botUsername, undefined, 'staff')]]);
}

/* ---------- сравнение регионов ---------- */

export function askRegionsText(professionTitle: string, limit: number): string {
  return [
    `Сравню «${professionTitle}» по регионам: где люди дешевле и где их больше.`,
    `Напишите до ${limit} регионов через запятую, например «СПб, Татарстан, Москва».`,
  ].join('\n');
}

export const askRegionsProfessionText = 'По какой должности сравнить регионы? Напишите название, например «повар» или «обвальщик мяса».';

export function regionsKeyboard(botUsername: string) {
  return Keyboard.inlineKeyboard([[Keyboard.button.openApp('Открыть сравнение регионов', botUsername, undefined, 'regions')]]);
}

/* ---------- сводка по региону ---------- */

export function digestKeyboard(botUsername: string) {
  return Keyboard.inlineKeyboard([[openRadarButton(botUsername, null, 'Открыть радар')]]);
}

export function helpText(): string {
  return [
    'Команды:',
    '/stavka — проверить ставку по должности и региону',
    '/profile — указать или сменить ИНН бизнеса',
    '/staff — мой штат: кто отстаёт от рынка и сколько стоит подтянуть',
    '/regions — сравнить регионы по одной должности',
    '/digest — сводка по рынку моего региона (для партнёров)',
    '/checks — плановые проверки на год по моему ИНН и по региону (ЕРКНМ)',
    '/vacancies — мои вакансии и отклики',
    '/demo — показать на примере реального микропредприятия',
    '/subs — мои подписки на изменения рынка',
    '/help — эта справка',
    '',
    'Должность можно не выбирать кнопкой, а написать текстом — любую, даже редкую: подскажу похожие позиции из справочника ОКПДТР «Работы России» (8 037 профессий) или посчитаю по вашему названию.',
    '',
    'Как считаю: беру живые вакансии портала «Работа России» по вашему региону, убираю дубли и лишние объявления одного работодателя, считаю медиану и перцентили заявленных ставок. Размер каждого работодателя узнаю в реестре МСП ФНС по ИНН. Плановые проверки беру из открытых данных Единого реестра контрольных (надзорных) мероприятий Генпрокуратуры. Никакой генерации: каждое число выводимо из источника.',
  ].join('\n');
}
