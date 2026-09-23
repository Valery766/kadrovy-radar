import type { PhraseRule, PhraseStat, VacancyRecord } from './types.js';

/**
 * Частотный разбор требований и обязанностей: какая доля вакансий упоминает
 * медкнижку, опыт, график и т. п. Правила — переменная часть (пакет), ядро только считает.
 */
export function phraseStats(vacancies: VacancyRecord[], rules: PhraseRule[], minShare = 0.05): PhraseStat[] {
  if (vacancies.length === 0) return [];
  const compiled = rules.map((r) => ({ r, res: r.patterns.map((p) => new RegExp(p, 'i')) }));
  const texts = vacancies.map((v) => `${v.requirement ?? ''}\n${v.duty ?? ''}`);
  const stats: PhraseStat[] = [];
  for (const { r, res } of compiled) {
    const count = texts.filter((t) => res.some((re) => re.test(t))).length;
    const share = count / vacancies.length;
    if (share >= minShare) stats.push({ key: r.key, label: r.label, count, share: Math.round(share * 100) });
  }
  return stats.sort((a, b) => b.count - a.count);
}

/** Распределение графиков работы (по полю schedule источника). */
export function scheduleStats(vacancies: VacancyRecord[], top = 4): { label: string; share: number }[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const v of vacancies) {
    const label = (v.schedule ?? '').trim();
    if (!label) continue;
    total += 1;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (total === 0) return [];
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([label, count]) => ({ label, share: Math.round((100 * count) / total) }));
}
