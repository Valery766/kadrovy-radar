import type { VacancyRecord } from './types.js';
import { normalizeText } from './text.js';

export interface DedupeResult {
  kept: VacancyRecord[];
  /** Сколько записей отброшено как точные дубли (тот же работодатель, название и вилка). */
  duplicates: number;
  /** Сколько записей отброшено по лимиту на одного работодателя. */
  capped: number;
}

/**
 * Дедупликация выдачи «Работы России».
 * Портал отдаёт одну и ту же вакансию сети по каждому адресу — без дедупликации
 * один работодатель с 200 объявлениями задаёт медиану всему рынку.
 * 1) точные дубли (ИНН + название + вилка) схлопываются;
 * 2) на одного работодателя остаётся не более perEmployerCap записей.
 */
export function dedupeVacancies(vacancies: VacancyRecord[], perEmployerCap: number): DedupeResult {
  const seen = new Set<string>();
  const perEmployer = new Map<string, number>();
  const kept: VacancyRecord[] = [];
  let duplicates = 0;
  let capped = 0;

  for (const v of vacancies) {
    const employerKey = v.employerInn ?? `id:${v.id}`;
    const key = `${employerKey}|${normalizeText(v.title)}|${v.salaryMin ?? ''}|${v.salaryMax ?? ''}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    const n = perEmployer.get(employerKey) ?? 0;
    if (n >= perEmployerCap) {
      capped += 1;
      continue;
    }
    perEmployer.set(employerKey, n + 1);
    kept.push(v);
  }
  return { kept, duplicates, capped };
}
