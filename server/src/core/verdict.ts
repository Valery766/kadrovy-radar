import type { MarketCard, OfferBand } from './types.js';
import { formatRub, pluralRu } from './text.js';

export function bandOf(percentile: number): OfferBand {
  if (percentile < 25) return 'low';
  if (percentile < 50) return 'below_median';
  if (percentile < 75) return 'market';
  return 'above';
}

/** Короткая подпись диапазона (для таблиц и подписей). */
export const BAND_LABEL: Record<OfferBand, string> = {
  low: 'ниже рынка',
  below_median: 'ниже середины рынка',
  market: 'как большинство',
  above: 'выше рынка',
};

/** Вывод одной фразой простыми словами: что ставка значит для владельца. */
export const BAND_PLAIN: Record<OfferBand, string> = {
  low: 'вы платите меньше большинства',
  below_median: 'вы платите чуть меньше половины рынка',
  market: 'вы платите как большинство',
  above: 'вы платите больше большинства',
};

/**
 * Детерминированный текст вердикта простыми словами. Это не генерация: каждое число берётся
 * из рассчитанной карточки, а формулировка выбирается по диапазону ставки.
 */
export function buildVerdict(card: Omit<MarketCard, 'verdict'>, professionTitle: string, regionName: string): string {
  const { stats, sample } = card;
  if (card.confidence === 'none' || !stats) {
    return `По запросу «${professionTitle}» в регионе «${regionName}» подходящих вакансий с зарплатой не нашлось. ` +
      'Попробуйте другое название должности или соседний регион.';
  }
  const parts: string[] = [];
  const sampleNote = `${sample.vacancies} ${pluralRu(sample.vacancies, 'объявление', 'объявления', 'объявлений')} от ${sample.employers} ${pluralRu(sample.employers, 'работодателя', 'работодателей', 'работодателей')}`;

  if (card.confidence === 'low') {
    parts.push(`Данных мало: только ${sampleNote}. Цифры ниже – ориентир, а не вывод.`);
  }

  if (card.offer) {
    const { value, percentile, shareAbove, band } = card.offer;
    const lead = BAND_PLAIN[band].replace(/^вы/, 'Вы');
    parts.push(`${lead}: ${shareAbove} из 100 работодателей предлагают на должность «${professionTitle}» в регионе «${regionName}» больше ваших ${formatRub(value)}. Только ${percentile} из 100 платят меньше.`);
  } else {
    parts.push(`Рынок «${professionTitle}», ${regionName}: ${sampleNote}.`);
  }

  parts.push(`Обычная ставка – ${formatRub(stats.median)} (медиана): половина работодателей платит меньше, половина больше. Половина всех вакансий укладывается в ${formatRub(stats.p25)}–${formatRub(stats.p75)}.`);

  if (card.sameSize && card.sameSize.median != null && card.sameSize.employers >= 3) {
    parts.push(`Работодатели вашего размера (${card.sameSize.label}) платят ${formatRub(card.sameSize.median)}.`);
  }

  if (card.offer && (card.offer.band === 'low' || card.offer.band === 'below_median')) {
    const median = card.options.find((o) => o.kind === 'median');
    const top = card.options.find((o) => o.kind === 'top');
    if (median && top) {
      parts.push(`С ${formatRub(median.value)} вы окажетесь в верхней половине рынка, с ${formatRub(top.value)} будете платить больше, чем три четверти работодателей.`);
    }
  } else if (card.offer && card.offer.band === 'market') {
    const top = card.options.find((o) => o.kind === 'top');
    if (top) parts.push(`Чтобы платить больше, чем три четверти работодателей, нужно от ${formatRub(top.value)}.`);
  } else if (card.offer) {
    parts.push('Ставка уже конкурентна: дальше решают условия работы и скорость ответа кандидатам.');
  }

  return parts.join(' ');
}
