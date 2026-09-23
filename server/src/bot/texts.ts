/** Тексты и клавиатуры бота. Всё детерминированно: числа берутся из карточки ядра. */
import { Keyboard } from '@maxhub/max-bot-api';

type KeyboardRows = Parameters<typeof Keyboard.inlineKeyboard>[0];
import { BAND_LABEL, categoryLabel, formatRub, pluralRu } from '../core/index.js';
import type { MarketResult } from '../services/market.js';
import type { BusinessProfile } from '../integrations/rmsp.js';
import type { Pack } from '../core/index.js';
import { openRadarButton } from '../services/report.js';

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

export function profileText(p: BusinessProfile, pack: Pack, regionName: string | null): string {
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
  return Keyboard.inlineKeyboard(rows);
}

export function helpText(): string {
  return [
    'Команды:',
    '/stavka — проверить ставку по должности и региону',
    '/profile — указать или сменить ИНН бизнеса',
    '/demo — показать на примере реального микропредприятия',
    '/subs — мои подписки на изменения рынка',
    '/help — эта справка',
    '',
    'Как считаю: беру живые вакансии портала «Работа России» по вашему региону, убираю дубли и лишние объявления одного работодателя, считаю медиану и перцентили заявленных ставок. Размер каждого работодателя узнаю в реестре МСП ФНС по ИНН. Никакой генерации: каждое число выводимо из источника.',
  ].join('\n');
}
