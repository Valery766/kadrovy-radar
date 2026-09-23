/**
 * PDF-отчёт «Ставка»: одна страница A4 с карточкой рынка. Генерируется детерминированно
 * из рассчитанной карточки (pdfkit, шрифт PT Sans — лицензия OFL, файл в assets/fonts).
 */
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { categoryLabel, formatRub, BAND_LABEL } from '../core/index.js';
import type { MarketResult } from '../services/market.js';

const FONT_REGULAR = fileURLToPath(new URL('../../assets/fonts/PT_Sans-Web-Regular.ttf', import.meta.url));
const FONT_BOLD = fileURLToPath(new URL('../../assets/fonts/PT_Sans-Web-Bold.ttf', import.meta.url));

const fmtDate = (iso: string) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export async function renderMarketPdf(result: MarketResult, opts: { appUrl?: string } = {}): Promise<Buffer> {
  const { card, profession, region, profile } = result;
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Ставка — ${profession.title}, ${region.name}`, Author: 'Ставка (хакатон MAX 2026, unecon.tech)' } });
  doc.registerFont('R', FONT_REGULAR).registerFont('B', FONT_BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width - 80;
  const accent = '#2F6BFF';
  const muted = '#6B7280';

  doc.font('B').fontSize(20).fillColor('#111').text('Ставка · зарплатный радар', { continued: true }).font('R').fontSize(11).fillColor(muted).text(`   отчёт от ${fmtDate(result.createdAt)} МСК`);
  doc.moveDown(0.3);
  doc.font('B').fontSize(15).fillColor('#111').text(`${profession.title} — ${region.name}`);
  doc.moveDown(0.2);
  if (profile && profile.inRegistry) {
    doc.font('R').fontSize(10).fillColor('#111').text(`${profile.name || 'Бизнес'} · ИНН ${profile.inn} · ${categoryLabel(profile.category)} · ОКВЭД ${profile.okved ?? '—'} ${profile.okvedName ?? ''}`);
    doc.fontSize(8.5).fillColor(muted).text(`Источник: Единый реестр субъектов МСП (ФНС России) · получено ${fmtDate(profile.fetchedAt)}`);
  } else if (profile) {
    doc.font('R').fontSize(10).fillColor('#111').text(`ИНН ${profile.inn}: в реестре МСП не найден (бюджетная организация, крупный бизнес или ликвидирован)`);
  }
  doc.moveDown(0.6);

  // Блок ключевых чисел
  const stats = card.stats;
  const boxY = doc.y;
  const cols = 4; const colW = W / cols;
  const tiles: [string, string][] = stats ? [
    ['Медиана', formatRub(stats.median)],
    ['Половина предложений', `${formatRub(stats.p25)} – ${formatRub(stats.p75)}`],
    ['Выборка', `${card.sample.vacancies} вак. / ${card.sample.employers} работод.`],
    card.offer ? ['Ваша ставка', `${formatRub(card.offer.value)} · ${card.offer.percentile}-й перц.`] : ['Достоверность', card.confidence === 'ok' ? 'достаточно данных' : 'мало данных'],
  ] : [['Данных нет', '—'], ['', ''], ['', ''], ['', '']];
  tiles.forEach(([label, value], i) => {
    const x = 40 + i * colW;
    doc.roundedRect(x + 2, boxY, colW - 4, 46, 6).fillAndStroke('#F3F6FF', '#DCE3F5');
    doc.fillColor(muted).font('R').fontSize(8.5).text(label, x + 8, boxY + 6, { width: colW - 16 });
    doc.fillColor('#111').font('B').fontSize(11).text(value, x + 8, boxY + 20, { width: colW - 16 });
  });
  doc.y = boxY + 56; doc.x = 40;

  // Вердикт
  doc.font('B').fontSize(11).fillColor('#111').text('Вердикт');
  doc.font('R').fontSize(10).fillColor('#111').text(card.verdict, { width: W });
  if (card.offer) doc.font('R').fontSize(9).fillColor(muted).text(`Оценка ставки: ${BAND_LABEL[card.offer.band]}. ${card.offer.shareAbove} % вакансий предлагают больше.`);
  doc.moveDown(0.5);

  // Гистограмма
  if (card.histogram.length > 1) {
    doc.font('B').fontSize(11).fillColor('#111').text('Распределение заявленных ставок');
    const hx = 40; const hy = doc.y + 4; const hh = 70; const hw = W;
    const maxCount = Math.max(...card.histogram.map((b) => b.count), 1);
    const bw = hw / card.histogram.length;
    card.histogram.forEach((b, i) => {
      const h = (b.count / maxCount) * hh;
      const isOffer = card.offer && card.offer.value >= b.from && card.offer.value < b.to;
      doc.rect(hx + i * bw + 2, hy + hh - h, bw - 4, h).fill(isOffer ? '#FF7A59' : accent);
      doc.fillColor(muted).font('R').fontSize(7).text(`${Math.round(b.from / 1000)}–${Math.round(b.to / 1000)}т`, hx + i * bw, hy + hh + 3, { width: bw, align: 'center' });
      doc.fillColor('#111').fontSize(7.5).text(String(b.count), hx + i * bw, hy + hh - h - 9, { width: bw, align: 'center' });
    });
    doc.y = hy + hh + 16; doc.x = 40;
    doc.moveDown(0.4);
  }

  // Варианты ставки
  if (card.options.length) {
    doc.font('B').fontSize(11).fillColor('#111').text('Варианты ставки');
    for (const o of card.options) {
      doc.font('R').fontSize(10).fillColor('#111').text(`• ${o.label}: ${formatRub(o.value)} — ${o.percentile}-й перцентиль рынка`);
    }
    doc.moveDown(0.4);
  }

  // Срезы по размеру работодателя
  if (card.byCategory.length) {
    doc.font('B').fontSize(11).fillColor('#111').text('Кто нанимает: размер работодателя (реестр МСП ФНС)');
    for (const c of card.byCategory) {
      doc.font('R').fontSize(10).fillColor('#111').text(`• ${c.label}: ${c.employers} работод., ${c.vacancies} вак., медиана ${c.median != null ? formatRub(c.median) : '—'}`);
    }
    doc.moveDown(0.4);
  }

  // Требования
  if (card.requirements.length) {
    doc.font('B').fontSize(11).fillColor('#111').text('Что пишут в требованиях');
    doc.font('R').fontSize(10).fillColor('#111').text(card.requirements.slice(0, 8).map((r) => `${r.label} — ${r.share} %`).join(' · '), { width: W });
    doc.moveDown(0.4);
  }

  // Примеры
  if (card.examples.length) {
    doc.font('B').fontSize(11).fillColor('#111').text('Типичные предложения (ближайшие к медиане)');
    for (const e of card.examples) {
      const cat = e.employerCategory === undefined ? '' : ` · ${categoryLabel(e.employerCategory ?? null)}`;
      doc.font('R').fontSize(9.5).fillColor('#111').text(`• ${e.title} — ${e.employerName ?? 'работодатель'}${cat}: ${e.salaryMin && e.salaryMax && e.salaryMin !== e.salaryMax ? `${formatRub(e.salaryMin)} – ${formatRub(e.salaryMax)}` : formatRub(e.value)}`, { width: W });
    }
    doc.moveDown(0.4);
  }

  if (result.closure && result.closure.observedDays >= 3 && result.closure.total >= 20) {
    const c = result.closure;
    const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
    doc.font('B').fontSize(11).fillColor('#111').text('Наблюдение за закрытием вакансий');
    doc.font('R').fontSize(10).fillColor('#111').text(`За ${c.observedDays} дн. наблюдений исчезли из выдачи: ${pct(c.closedAbove, c.totalAbove)} % вакансий со ставкой не ниже медианы и ${pct(c.closedBelow, c.totalBelow)} % — ниже медианы (${c.total} вакансий под наблюдением).`, { width: W });
    doc.moveDown(0.4);
  }

  // Источники и метод
  doc.font('B').fontSize(10).fillColor('#111').text('Источники и метод');
  for (const s of result.sources) doc.font('R').fontSize(8.5).fillColor(muted).text(`• ${s.title} — ${s.url} · получено ${fmtDate(s.fetchedAt)}${s.note ? ` · ${s.note}` : ''}`, { width: W });
  doc.font('R').fontSize(8.5).fillColor(muted).text(`Расчёт: ставка вакансии = середина вилки; точные дубли и объявления одного работодателя сверх лимита исключены (отброшено: ${Object.entries(card.sample.dropped).map(([k, v]) => `${k} ${v}`).join(', ') || '0'}); перцентиль = доля вакансий со ставкой ниже вашей. Это заявленные в вакансиях ставки на государственном портале, а не фактические выплаты. Пакет контекста: ${result.pack.title} v${result.pack.version}.`, { width: W });
  if (opts.appUrl) doc.font('R').fontSize(8.5).fillColor(accent).text(`Открыть карточку в MAX: ${opts.appUrl}`, { width: W });

  doc.end();
  return done;
}
