import type { Profession, VacancyRecord } from './types.js';
import { normalizeText } from './text.js';

export type TitleMatch = { matched: true } | { matched: false; reason: 'no_synonym' | 'excluded' };

/**
 * Относится ли название вакансии к профессии пакета.
 * Правило простое и объяснимое: есть хотя бы один синоним и нет ни одного исключения.
 */
export function matchTitle(title: string, profession: Profession, typicalPosition?: string | null): TitleMatch {
  const t = normalizeText(title);
  const tp = normalizeText(typicalPosition);
  if (!t && !tp) return { matched: false, reason: 'no_synonym' };
  const has = (s: string) => t.includes(normalizeText(s)) || (tp !== '' && tp.includes(normalizeText(s)));
  const hasSynonym = profession.synonyms.some(has);
  if (!hasSynonym) return { matched: false, reason: 'no_synonym' };
  // Исключения проверяем по названию вакансии: «шеф-повар» с typicalPosition «повар» – всё равно другая роль.
  const excluded = profession.exclude.some((e) => t.includes(normalizeText(e)));
  if (excluded) return { matched: false, reason: 'excluded' };
  return { matched: true };
}

/** Рыночное значение вакансии: середина вилки; при одной границе – она сама. */
export function salaryValue(v: Pick<VacancyRecord, 'salaryMin' | 'salaryMax'>): number | null {
  const lo = v.salaryMin && v.salaryMin > 0 ? v.salaryMin : null;
  const hi = v.salaryMax && v.salaryMax > 0 ? v.salaryMax : null;
  if (lo == null && hi == null) return null;
  if (lo == null) return hi;
  if (hi == null) return lo;
  return (lo + hi) / 2;
}
