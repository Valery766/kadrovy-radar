/**
 * PDF-отчёт «Кадрового радара»: одна страница A4 с карточкой рынка. Генерируется детерминированно
 * из рассчитанной карточки (pdfkit, шрифт PT Sans, лицензия OFL, файл в assets/fonts).
 * Каждое число подписано словами: что оно значит для владельца.
 */
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { BAND_PLAIN, DROPPED_LABEL, formatRub, sizeLabel } from '../core/index.js';
import type { MarketResult } from '../services/market.js';

const FONT_REGULAR = fileURLToPath(new URL('../../assets/fonts/PT_Sans-Web-Regular.ttf', import.meta.url));
const FONT_BOLD = fileURLToPath(new URL('../../assets/fonts/PT_Sans-Web-Bold.ttf', import.meta.url));

const fmtDate = (iso: string) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Что даёт каждый вариант ставки, простыми словами. */
const OPTION_EXPLAIN: Record<string, string> = {
  keep: 'оставить свою ставку как есть',
  median: 'обычная ставка рынка (медиана): половина работодателей платит меньше, половина больше',
  top: 'больше, чем у трёх четвертей работодателей (верхняя четверть)',
};

export async function renderMarketPdf(result: MarketResult, opts: { appUrl?: string } = {}): Promise<Buffer> {
  const { card, profession, region, profile } = result;
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Кадровый радар – ${profession.title}, ${region.name}`, Author: 'Кадровый радар (хакатон MAX 2026, unecon.tech)' } });
  doc.registerFont('R', FONT_REGULAR).registerFont('B', FONT_BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width - 80;
  const accent = '#2F6BFF';
  const muted = '#6B7280';

  doc.font('B').fontSize(20).fillColor('#111').text('Кадровый радар', { continued: true }).font('R').fontSize(11).fillColor(muted).text(`   отчёт от ${fmtDate(result.createdAt)} МСК`);
  doc.moveDown(0.3);
  doc.font('B').fontSize(15).fillColor('#111').text(`${profession.title} – ${region.name}`);
  doc.moveDown(0.2);
  if (profile && profile.inRegistry) {
    doc.font('R').fontSize(10).fillColor('#111').text(`${profile.name || 'Бизнес'} · ИНН ${profile.inn} · ${sizeLabel(profile.category)} · вид деятельности: ${profile.okvedName ?? 'не указан'}${profile.okved ? ` (код ${profile.okved})` : ''}`);
    doc.fontSize(8.5).fillColor(muted).text(`Источник: Единый реестр субъектов МСП (ФНС России) · получено ${fmtDate(profile.fetchedAt)}`);
  } else if (profile) {
    doc.font('R').fontSize(10).fillColor('#111').text(`ИНН ${profile.inn}: в реестре малого бизнеса не найден (бюджетная организация, крупный бизнес или ликвидирован)`);
  }
  doc.moveDown(0.6);

  // Блок ключевых чисел: каждая плитка подписана словами.
  const stats = card.stats;
  const boxY = doc.y;
  const cols = 4; const colW = W / cols;
  const tiles: [string, string][] = stats ? [
    ['Обычная ставка (медиана)', formatRub(stats.median)],
    ['Половина вакансий платит', `${formatRub(stats.p25)} – ${formatRub(stats.p75)}`],
    ['Посчитано по', `${card.sample.vacancies} объявл. / ${card.sample.employers} работод.`],
    card.offer ? ['Ваша ставка', formatRub(card.offer.value)] : ['Данных', card.confidence === 'ok' ? 'достаточно для вывода' : 'мало, только ориентир'],
  ] : [['Данных нет', '–'], ['', ''], ['', ''], ['', '']];
  tiles.forEach(([label, value], i) => {
    const x = 40 + i * colW;
    doc.roundedRect(x + 2, boxY, colW - 4, 46, 6).fillAndStroke('#F3F6FF', '#DCE3F5');
    doc.fillColor(muted).font('R').fontSize(8.5).text(label, x + 8, boxY + 6, { width: colW - 16 });
    doc.fillColor('#111').font('B').fontSize(11).text(value, x + 8, boxY + 20, { width: colW - 16 });
  });
  doc.y = boxY + 56; doc.x = 40;

  // Вывод простыми словами
  doc.font('B').fontSize(11).fillColor('#111').text('Вывод');
  doc.font('R').fontSize(10).fillColor('#111').text(card.verdict, { width: W });
  if (card.offer) {
    const o = card.offer;
    doc.font('R').fontSize(9).fillColor(muted).text(`Что это значит: ${BAND_PLAIN[o.band]}. ${o.shareAbove} из 100 работодателей предлагают больше ваших ${formatRub(o.value)}, только ${o.percentile} из 100 платят меньше (${o.percentile}-й перцентиль).`, { width: W });
  }
  if (stats) doc.font('R').fontSize(9).fillColor(muted).text('Обычная ставка (медиана) – это середина рынка: половина работодателей платит меньше, половина больше. Половина всех вакансий укладывается в коридор из второй плитки.', { width: W });
  doc.moveDown(0.5);

  // Гистограмма
  if (card.histogram.length > 1) {
    doc.font('B').fontSize(11).fillColor('#111').text('Сколько объявлений на каждую ставку (тысяч рублей в месяц)');
    const hx = 40; const hy = doc.y + 4; const hh = 70; const hw = W;
    const maxCount = Math.max(...card.histogram.map((b) => b.count), 1);
    const bw = hw / card.histogram.length;
    card.histogram.forEach((b, i) => {
      const h = (b.count / maxCount) * hh;
      const isOffer = card.offer && card.offer.value >= b.from && card.offer.value < b.to;
      doc.rect(hx + i * bw + 2, hy + hh - h, bw - 4, h).fill(isOffer ? '#FF7A59' : accent);
      doc.fillColor(muted).font('R').fontSize(7).text(`${Math.round(b.from / 1000)}–${Math.round(b.to / 1000)}`, hx + i * bw, hy + hh + 3, { width: bw, align: 'center' });
      doc.fillColor('#111').fontSize(7.5).text(String(b.count), hx + i * bw, hy + hh - h - 9, { width: bw, align: 'center' });
    });
    doc.y = hy + hh + 16; doc.x = 40;
    if (card.offer) doc.font('R').fontSize(8.5).fillColor(muted).text('Оранжевый столбец – там, где ваша ставка.', { width: W });
    doc.moveDown(0.4);
  }

  // Варианты ставки
  if (card.options.length) {
    doc.font('B').fontSize(11).fillColor('#111').text('Варианты ставки');
    for (const o of card.options) {
      doc.font('R').fontSize(10).fillColor('#111').text(`• ${formatRub(o.value)} – ${OPTION_EXPLAIN[o.kind] ?? o.label}. С такой ставкой вы будете платить больше, чем ${o.percentile} из 100 работодателей.`, { width: W });
    }
    doc.moveDown(0.4);
  }

  // Срезы по размеру работодателя
  if (card.byCategory.length) {
    doc.font('B').fontSize(11).fillColor('#111').text('Кто нанимает: размер работодателя по реестру МСП ФНС');
    for (const c of card.byCategory) {
      doc.font('R').fontSize(10).fillColor('#111').text(`• ${sizeLabel(c.category)}: ${c.employers} работод., ${c.vacancies} объявл., обычная ставка ${c.median != null ? formatRub(c.median) : 'не посчитана'}`, { width: W });
    }
    doc.font('R').fontSize(8.5).fillColor(muted).text('Сравнение с работодателями вашего размера честнее, чем со всем рынком: у крупных компаний и бюджета другие бюджеты на людей.', { width: W });
    doc.moveDown(0.4);
  }

  // Требования
  if (card.requirements.length) {
    doc.font('B').fontSize(11).fillColor('#111').text('Что чаще всего просят в объявлениях');
    doc.font('R').fontSize(10).fillColor('#111').text(card.requirements.slice(0, 8).map((r) => `${r.label} (в ${r.share} % объявлений)`).join(' · '), { width: W });
    doc.moveDown(0.4);
  }

  // Примеры
  if (card.examples.length) {
    doc.font('B').fontSize(11).fillColor('#111').text('Типичные объявления (ближайшие к обычной ставке)');
    for (const e of card.examples) {
      const cat = e.employerCategory === undefined ? '' : ` · ${sizeLabel(e.employerCategory ?? null)}`;
      doc.font('R').fontSize(9.5).fillColor('#111').text(`• ${e.title} – ${e.employerName ?? 'работодатель'}${cat}: ${e.salaryMin && e.salaryMax && e.salaryMin !== e.salaryMax ? `${formatRub(e.salaryMin)} – ${formatRub(e.salaryMax)}` : formatRub(e.value)}`, { width: W });
    }
    doc.moveDown(0.4);
  }

  if (result.closure && result.closure.observedDays >= 3 && result.closure.total >= 20) {
    const c = result.closure;
    const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
    doc.font('B').fontSize(11).fillColor('#111').text('Как быстро закрываются вакансии');
    doc.font('R').fontSize(10).fillColor('#111').text(`За ${c.observedDays} дн. наблюдений исчезли из выдачи ${pct(c.closedAbove, c.totalAbove)} % объявлений со ставкой не ниже обычной и ${pct(c.closedBelow, c.totalBelow)} % объявлений со ставкой ниже обычной (${c.total} объявлений под наблюдением). Исчезнувшее объявление обычно значит, что человека нашли.`, { width: W });
    doc.moveDown(0.4);
  }

  // Что дальше
  doc.font('B').fontSize(11).fillColor('#111').text('Что дальше');
  doc.font('R').fontSize(10).fillColor('#111').text('1) Выберите вариант ставки из списка выше. 2) В боте нажмите «Текст вакансии»: готовое объявление на обычную ставку рынка. 3) «Опубликовать»: ссылка и QR для кандидатов, отклики придут в MAX. 4) «Следить за рынком»: напишу, когда обычная ставка сдвинется.', { width: W });
  doc.moveDown(0.4);

  // Источники и метод
  const dropped = Object.entries(card.sample.dropped).filter(([, v]) => v > 0).map(([k, v]) => `${DROPPED_LABEL[k] ?? k} ${v}`).join(', ') || 'ничего';
  doc.font('B').fontSize(10).fillColor('#111').text('Источники и как считали');
  for (const s of result.sources) doc.font('R').fontSize(8.5).fillColor(muted).text(`• ${s.title} – ${s.url} · получено ${fmtDate(s.fetchedAt)}${s.note ? ` · ${s.note}` : ''}`, { width: W });
  doc.font('R').fontSize(8.5).fillColor(muted).text(`Как считали: ставка объявления = середина вилки «от – до»; повторы одного работодателя считаем один раз (не подошло: ${dropped}); «платят меньше N из 100» = доля объявлений со ставкой ниже вашей; самый крупный работодатель даёт ${card.sample.topEmployerShare} % объявлений. Это ставки, заявленные в объявлениях на государственном портале, а не фактические выплаты. Отрасль: ${result.pack.title}. Все цифры взяты из объявлений, ничего не придумано.`, { width: W });
  if (opts.appUrl) doc.font('R').fontSize(8.5).fillColor(accent).text(`Открыть карточку в MAX: ${opts.appUrl}`, { width: W });

  doc.end();
  return done;
}
