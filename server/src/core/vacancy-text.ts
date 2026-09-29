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
 * Минимальный детерминированный черновик: должность, регион и выбранная зарплата.
 * Не приписывает работодателю обязанности и льготы из чужих объявлений.
 * Реальные условия пользователь редактирует и подтверждает перед публикацией.
 */
export function buildVacancyDraft(input: VacancyDraftInput): string {
  const { profession, salary, companyName, cityName } = input;
  const lines: string[] = [];
  lines.push(`${profession.title} – ${cityName}`);
  if (companyName) lines.push(companyName);
  lines.push('');
  lines.push(`Зарплата: от ${formatRub(salary)} в месяц до вычета НДФЛ.`);
  lines.push('Место работы, график и обязанности уточняются при собеседовании.');
  lines.push('');
  lines.push('Откликнитесь в MAX: укажите опыт и ожидания по зарплате. Работодатель рассмотрит ответы и свяжется с вами.');
  return lines.join('\n');
}
