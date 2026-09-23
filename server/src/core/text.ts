/** Утилиты нормализации текста (ядро). */

export function normalizeText(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`]/g, ' ')
    .replace(/[ \s]+/g, ' ')
    .trim();
}

/** Форматирование суммы: 69000 → «69 000 ₽». */
export function formatRub(value: number): string {
  return `${Math.round(value).toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`;
}

/** Округление вверх до ближайшей тысячи. */
export function roundUpThousand(value: number): number {
  return Math.ceil(value / 1000) * 1000;
}

/** Порядковое числительное для перцентиля: 21 → «21-й». */
export function ordinalRu(n: number): string {
  return `${n}-й`;
}

export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** Дата и время по Москве для подписи источника: «23.09, 12:00». */
export function formatDateTimeRu(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** «2026-03-16» → «16.03.2026»; пусто – прочерк. */
export function formatDateRu(iso: string | null): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '–';
}

/** Строка источника и даты под любым ответом с цифрами. */
export function sourceNote(fetchedAt: string | null): string {
  const when = fetchedAt ? ` на ${formatDateTimeRu(fetchedAt)}` : '';
  return `По данным «Работы России»${when}; размеры работодателей – реестр МСП ФНС. Все цифры взяты из объявлений, ничего не придумано.`;
}

/** Процент по-русски: 14.3 → «14,3 %». */
export function formatPct(value: number): string {
  return `${String(value).replace('.', ',')} %`;
}
