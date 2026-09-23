import type { MarketCard, OfferBand } from './types.js';
import { formatRub, ordinalRu, pluralRu } from './text.js';

export function bandOf(percentile: number): OfferBand {
  if (percentile < 25) return 'low';
  if (percentile < 50) return 'below_median';
  if (percentile < 75) return 'market';
  return 'above';
}

export const BAND_LABEL: Record<OfferBand, string> = {
  low: 'ниже рынка',
  below_median: 'ниже медианы',
  market: 'в рынке',
  above: 'выше рынка',
};

/**
 * Детерминированный текст вердикта. Это не генерация: каждое число берётся
 * из рассчитанной карточки, а формулировка выбирается по диапазону перцентиля.
 */
export function buildVerdict(card: Omit<MarketCard, 'verdict'>, professionTitle: string, regionName: string): string {
  const { stats, sample } = card;
  if (card.confidence === 'none' || !stats) {
    return `По запросу «${professionTitle}» в регионе «${regionName}» подходящих вакансий с зарплатой не нашлось. ` +
      'Попробуйте другое название должности или соседний регион.';
  }
  const parts: string[] = [];
  const sampleNote = `${sample.vacancies} ${pluralRu(sample.vacancies, 'вакансия', 'вакансии', 'вакансий')} от ${sample.employers} ${pluralRu(sample.employers, 'работодателя', 'работодателей', 'работодателей')}`;

  if (card.confidence === 'low') {
    parts.push(`Данных мало: ${sampleNote}. Интервал широкий, цифры ниже — ориентир, а не вывод.`);
  }

  if (card.offer) {
    const { value, percentile, shareAbove, band } = card.offer;
    parts.push(`Ваши ${formatRub(value)} — ${ordinalRu(percentile)} перцентиль (${BAND_LABEL[band]}): ${shareAbove} % вакансий «${professionTitle}» в регионе «${regionName}» платят больше.`);
  } else {
    parts.push(`Рынок «${professionTitle}», ${regionName}: ${sampleNote}.`);
  }

  parts.push(`Медиана — ${formatRub(stats.median)}, половина предложений укладывается в ${formatRub(stats.p25)}–${formatRub(stats.p75)}.`);

  if (card.sameSize && card.sameSize.median != null && card.sameSize.employers >= 3) {
    parts.push(`Среди работодателей вашего размера (${card.sameSize.label}) медиана — ${formatRub(card.sameSize.median)}.`);
  }

  if (card.offer && card.offer.band !== 'above') {
    const median = card.options.find((o) => o.kind === 'median');
    const top = card.options.find((o) => o.kind === 'top');
    if (median && top) {
      parts.push(`При ${formatRub(median.value)} вы окажетесь в верхней половине рынка, при ${formatRub(top.value)} — в верхней четверти.`);
    }
  } else if (card.offer) {
    parts.push('Ставка уже конкурентна: дальше решают условия и скорость ответа кандидатам.');
  }

  return parts.join(' ');
}
