import type { MarketCard, Pack, Profession } from './types.js';
import { formatRub } from './text.js';

export interface VacancyDraftInput {
  card: MarketCard;
  profession: Profession;
  pack: Pack;
  salary: number;
  companyName: string | null;
  cityName: string;
}

/**
 * Черновик вакансии, собранный детерминированно: ставка — из выбранного варианта,
 * требования — самые частые формулировки рынка (частотный разбор ядра),
 * условия — шаблон пакета. Никакой генерации: каждая строка выводима из данных.
 */
export function buildVacancyDraft(input: VacancyDraftInput): string {
  const { card, profession, pack, salary, companyName, cityName } = input;
  const lines: string[] = [];
  lines.push(`${profession.title} — ${cityName}`);
  if (companyName) lines.push(companyName);
  lines.push('');
  lines.push(`Зарплата: от ${formatRub(salary)}${card.stats ? ` (медиана рынка — ${formatRub(card.stats.median)})` : ''}`);
  if (card.schedules.length) {
    lines.push(`График: ${card.schedules[0]!.label.toLowerCase()}`);
  }
  lines.push('');
  lines.push('Требования (так пишут работодатели региона):');
  const reqs = card.requirements.slice(0, 6);
  if (reqs.length === 0) lines.push('— опыт работы по специальности');
  for (const r of reqs) lines.push(`— ${r.label} (упоминают ${r.share} % вакансий)`);
  lines.push('');
  lines.push('Условия:');
  for (const c of pack.vacancyTemplate.conditions) lines.push(`— ${c}`);
  lines.push('');
  lines.push(`Источник рыночных данных: «Работа России» (Роструд), ${card.sample.vacancies} вакансий от ${card.sample.employers} работодателей.`);
  return lines.join('\n');
}
