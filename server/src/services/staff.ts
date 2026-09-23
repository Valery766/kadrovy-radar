/**
 * Сервис «Штат и удержание»: по списку должностей владельца получает рынки
 * (кэш → «Работа России» → реестр МСП) и отдаёт оценку ядра: кто ниже рынка,
 * на сколько и сколько стоит подтянуть всех до медианы.
 */
import { assessStaff, formatPct, formatRub, pluralRu, sourceNote, type MarketCard, type Profession, type StaffPosition, type StaffReport } from '../core/index.js';
import { regionByFnsCode, resolveProfession, selectPack, type RegionInfo } from '../packs/loader.js';
import type { BusinessProfile } from '../integrations/rmsp.js';
import { SOURCES } from '../integrations/index.js';
import { buildMarket, getProfile, MarketError, type MarketContext, type SourceBadge } from './market.js';
import { mapLimit } from './pool.js';

/** Сколько рынков считаем одновременно: у источника латентность 6–11 с на страницу. */
const MARKET_CONCURRENCY = 3;

export interface StaffPositionInput {
  /** Идентификатор строки; если не задан – подставляется порядковый номер. */
  id?: string;
  title: string;
  salary: number;
  /** Ключ профессии, если пользователь выбрал её из каталога или подсказки. */
  professionKey?: string | null;
}

export interface StaffRequest {
  positions: StaffPositionInput[];
  inn: string | null;
  /** Код ФНС региона; если не задан – берётся из профиля по ИНН. */
  regionFnsCode: string | null;
  maxUserId: number | null;
  forceRefresh?: boolean;
}

export interface StaffMarketRef {
  professionKey: string;
  professionTitle: string;
  /** Карточка рынка в БД – можно открыть в мини-приложении. */
  cardId: string | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  vacancies: number;
  employers: number;
  confidence: MarketCard['confidence'] | null;
  fetchedAt: string | null;
  /** Причина, по которой рынок не посчитан (остальные позиции это не ломает). */
  error: string | null;
}

export interface StaffResult {
  report: StaffReport;
  markets: StaffMarketRef[];
  region: RegionInfo;
  profile: BusinessProfile | null;
  pack: { id: string; title: string; version: number };
  sources: SourceBadge[];
  /** Детерминированный текст для чата бота. */
  text: string;
  createdAt: string;
}

/** Ограничение вежливости: одна карточка штата – не больше 20 строк. */
export const MAX_STAFF_POSITIONS = 20;

/** Оценка штата: рынки по каждой уникальной должности + расчёт ядра + текст для чата. */
export async function buildStaffAssessment(ctx: MarketContext, req: StaffRequest): Promise<StaffResult> {
  const positions = req.positions.slice(0, MAX_STAFF_POSITIONS);
  if (positions.length === 0) throw new MarketError('profession_unknown', 'Список должностей пуст');

  const profile = req.inn ? await getProfile(ctx, req.inn) : null;
  const regionFns = req.regionFnsCode ?? profile?.fnsRegionCode ?? null;
  const region = regionByFnsCode(ctx.catalog, regionFns);
  if (!region) throw new MarketError('region_unknown', 'Не удалось определить регион: укажите его вручную');
  const pack = selectPack(ctx.catalog, { fnsRegionCode: region.fnsCode, okved: profile?.okved ?? null });

  // Должность → профессия: выбранный ключ каталога либо свободный ввод названия.
  const pool = [...pack.professions, ...ctx.catalog.professions];
  const resolved = positions.map((p, i) => {
    const byKey = p.professionKey ? pool.find((x) => x.key === p.professionKey) ?? null : null;
    const profession = byKey ?? resolveProfession(ctx.catalog, pack, p.title);
    return { id: p.id ?? `p${i + 1}`, title: p.title.trim(), salary: p.salary, profession };
  });

  const unique = new Map<string, Profession>();
  for (const r of resolved) if (r.profession) unique.set(r.profession.key, r.profession);
  const professions = [...unique.values()];

  const settled = await mapLimit(professions, MARKET_CONCURRENCY, (profession) => buildMarket(ctx, {
    professionKey: profession.key,
    profession,
    regionFnsCode: region.fnsCode,
    inn: req.inn,
    offer: null,
    maxUserId: req.maxUserId,
    forceRefresh: req.forceRefresh ?? false,
    persist: req.maxUserId != null,
  }));

  const cards = new Map<string, MarketCard>();
  const markets: StaffMarketRef[] = professions.map((profession, i) => {
    const r = settled[i]!;
    if (!r.ok) {
      ctx.log.warn({ professionKey: profession.key, region: region.fnsCode, err: r.error.message }, 'штат: рынок не посчитан');
      return { professionKey: profession.key, professionTitle: profession.title, cardId: null, median: null, p25: null, p75: null, vacancies: 0, employers: 0, confidence: null, fetchedAt: null, error: r.error.message };
    }
    cards.set(profession.key, r.value.card);
    const { card } = r.value;
    return {
      professionKey: profession.key,
      professionTitle: card.professionTitle,
      cardId: r.value.cardId,
      median: card.stats?.median ?? null,
      p25: card.stats?.p25 ?? null,
      p75: card.stats?.p75 ?? null,
      vacancies: card.sample.vacancies,
      employers: card.sample.employers,
      confidence: card.confidence,
      fetchedAt: r.value.fetched.fetchedAt,
      error: null,
    };
  });

  const staffPositions: StaffPosition[] = resolved.map((r) => ({
    id: r.id, title: r.title, salary: r.salary, professionKey: r.profession?.key ?? null,
  }));
  const report = assessStaff(staffPositions, cards);

  const createdAt = new Date().toISOString();
  const fetchedAt = markets.find((m) => m.fetchedAt)?.fetchedAt ?? createdAt;
  const sources: SourceBadge[] = [
    { ...SOURCES.trudvsem, fetchedAt, note: `рынок по ${markets.length} ${pluralRu(markets.length, 'должности', 'должностям', 'должностям')} в регионе «${region.name}»` },
    { ...SOURCES.rmsp, fetchedAt: profile?.fetchedAt ?? createdAt, note: profile ? 'профиль бизнеса и категории работодателей' : 'категории работодателей' },
  ];

  return { report, markets, region, profile, pack: { id: pack.id, title: pack.title, version: pack.version }, sources, text: staffText(report, region.name, fetchedAt), createdAt };
}

/** Текст сводки по штату для чата: детерминированный шаблон простыми словами, без генеративных моделей. */
export function staffText(report: StaffReport, regionName: string, fetchedAt: string | null = null): string {
  const { summary, positions } = report;
  const lines: string[] = [];
  lines.push(`👥 Ваш штат и рынок, ${regionName}: ${summary.positions} ${pluralRu(summary.positions, 'должность', 'должности', 'должностей')}, сравнил с рынком ${summary.assessed}.`);
  if (summary.assessed === 0) {
    lines.push('Рынок ни по одной должности не набрал объявлений с зарплатой, сравнивать не с чем.');
    lines.push('');
    lines.push('Что дальше: уточните названия должностей (например, «повар» вместо «повар 5 разряда») или проверьте регион: /profile. Затем повторите: /staff.');
    return lines.join('\n');
  }
  const lagging = summary.highRisk + summary.mediumRisk;
  lines.push('');
  // 1. Вывод одной фразой.
  if (lagging === 0) lines.push('Все сотрудники, по которым есть данные, получают как рынок или больше: переманить их сложнее.');
  else lines.push(`${lagging} из ${summary.assessed} ${pluralRu(summary.assessed, 'сотрудника', 'сотрудников', 'сотрудников')} получают меньше рынка${summary.highRisk ? `, из них ${summary.highRisk} – заметно меньше: их проще всего переманить` : ''}.`);
  lines.push('');
  // 2. Числа с объяснением.
  lines.push(`Заметно ниже рынка: ${summary.highRisk}. Получают меньше, чем в трёх четвертях вакансий региона (высокий риск ухода).`);
  lines.push(`Немного ниже рынка: ${summary.mediumRisk}. Получают меньше обычной ставки рынка, но не в самом низу.`);
  lines.push(`Как рынок или выше: ${summary.inMarket}.`);
  lines.push(`Фонд оплаты по вашим ставкам: ${formatRub(summary.payroll)} в месяц.`);
  lines.push(summary.costToMedian > 0
    ? `Чтобы все получали обычную рыночную ставку, фонд вырастет на ${formatRub(summary.costToMedian)} в месяц (+${formatPct(summary.costShare)} к фонду).`
    : 'Доплачивать до обычной рыночной ставки никому не нужно.');
  const risky = positions.filter((p) => p.risk === 'high' || p.risk === 'medium').slice(0, 5);
  if (risky.length) {
    lines.push('');
    lines.push('Кого проще переманить, сначала самые отстающие:');
    for (const p of risky) {
      const where = p.percentile != null ? ` Получает меньше, чем в ${100 - p.percentile} из 100 вакансий региона.` : '';
      lines.push(`• ${p.title}: ${formatRub(p.salary)}. Обычная ставка рынка ${formatRub(p.median ?? 0)}, не хватает ${formatRub(p.gapRub)} (${formatPct(p.gapPct)}).${where}`);
    }
  }
  if (summary.unknown > 0) lines.push(`Без оценки: ${summary.unknown}. По этим должностям объявлений с зарплатой не нашлось.`);
  lines.push('');
  // 3. Что это значит для вас.
  const meaning = summary.highRisk > 0
    ? 'сотрудники с высоким риском ухода получают меньше, чем большинство работодателей региона, конкурентам легко их переманить. Начните с них.'
    : summary.mediumRisk > 0
      ? 'отстающие получают немного меньше обычной ставки: риск ухода есть, но небольшой. Поднять их до рынка дешевле, чем искать замену.'
      : 'ставки в рынке, удержание пока не требует денег. Следите за рынком раз в квартал.';
  lines.push(`Что это значит для вас: ${meaning}`);
  lines.push('');
  // 4. Что дальше.
  lines.push('Что дальше:');
  lines.push('1) Откройте «Мой штат в приложении»: там весь список и график по каждой должности.');
  lines.push('2) Решите, кому поднять ставку первым: начните с тех, кто заметно ниже рынка.');
  lines.push('3) Проверьте одну должность подробнее: /stavka. Следить за рынком можно кнопкой под её карточкой.');
  lines.push('');
  // 5. Источник и дата.
  lines.push(sourceNote(fetchedAt));
  return lines.join('\n');
}
