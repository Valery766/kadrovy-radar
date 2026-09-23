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
