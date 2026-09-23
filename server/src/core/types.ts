/**
 * Ядро «Ставки»: модель данных движка рынка труда.
 * Ядро не знает ни о MAX, ни о конкретных регионах и отраслях – весь контекст
 * приходит снаружи в виде пакета (Pack) и записей вакансий (VacancyRecord).
 */

/** Категория субъекта МСП по реестру ФНС: 0 – не МСП, 1 – микро, 2 – малое, 3 – среднее. */
export type MspCategory = 0 | 1 | 2 | 3;

export interface EmployerProfile {
  inn: string;
  name: string;
  /** null – работодатель не найден в реестре МСП (бюджет, крупный бизнес, ликвидирован). */
  category: MspCategory | null;
  okved: string | null;
  okvedName: string | null;
  /** Двузначный код региона ФНС, например "78". */
  fnsRegionCode: string | null;
  kind: 'UL' | 'IP' | null;
  registeredAt: string | null;
  active: boolean | null;
}

export interface VacancyRecord {
  id: string;
  title: string;
  salaryMin: number | null;
  salaryMax: number | null;
  employerInn: string | null;
  employerOgrn: string | null;
  employerName: string | null;
  /** Нормализованное название должности от источника (typicalPosition), если есть. */
  typicalPosition: string | null;
  /** Код профессии по ОКПДТР от источника. */
  codeProfession: string | null;
  /** 13-значный код региона портала «Работа России», например "7800000000000". */
  regionCode: string;
  schedule: string | null;
  employment: string | null;
  /** Текст требований (включая требуемые медицинские документы). */
  requirement: string | null;
  duty: string | null;
  /** Требуемый опыт, лет (0 – без опыта), если указан. */
  experienceYears: number | null;
  education: string | null;
  /** Число рабочих мест в объявлении. */
  workPlaces: number | null;
  /** Кадровое агентство, а не работодатель. */
  hrAgency: boolean;
  url: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  lat: number | null;
  lng: number | null;
  /** Обогащение через реестр МСП ФНС (по ИНН работодателя), если выполнялось. */
  employer?: EmployerProfile | null;
}

export interface Profession {
  key: string;
  title: string;
  /** Текст запроса к источнику вакансий. */
  query: string;
  /** Подстроки названий вакансий, которые считаем этой профессией. */
  synonyms: string[];
  /** Подстроки, при наличии которых вакансия исключается (другая роль). */
  exclude: string[];
}

export interface Thresholds {
  /** Минимум уникальных работодателей для уверенного вывода. */
  minEmployers: number;
  /** Минимум вакансий для уверенного вывода. */
  minVacancies: number;
  /** Нижняя граница правдоподобной зарплаты, ₽/мес. */
  salaryMin: number;
  /** Верхняя граница правдоподобной зарплаты, ₽/мес. */
  salaryMax: number;
  /** Сколько вакансий одного работодателя учитывать максимум (защита от сетей с сотнями одинаковых объявлений). */
  perEmployerCap: number;
}

export interface PhraseRule {
  key: string;
  label: string;
  /** Регулярные выражения (без флагов; применяются как /.../i к тексту требований и обязанностей). */
  patterns: string[];
}

export interface PackRegion {
  /** Двузначный код региона ФНС ("78"). */
  fnsCode: string;
  name: string;
}

export interface PackIndustry {
  okvedPrefixes: string[];
  title: string;
}

export interface PackDemo {
  inn: string;
  profession: string;
  salary: number;
  note?: string;
}

export interface Pack {
  id: string;
  title: string;
  version: number;
  /** null – универсальный пакет: регион берётся из профиля бизнеса. */
  region: PackRegion | null;
  /** null – универсальный пакет: отрасль не ограничена. */
  industry: PackIndustry | null;
  professions: Profession[];
  thresholds: Thresholds;
  requirementPhrases: PhraseRule[];
  /** Шаблоны вакансии: заголовок и блоки условий по умолчанию. */
  vacancyTemplate: {
    conditions: string[];
  };
  demo: PackDemo | null;
}

export type Confidence = 'ok' | 'low' | 'none';
export type OfferBand = 'low' | 'below_median' | 'market' | 'above';

export interface SalaryStats {
  n: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  mean: number;
}

export interface HistogramBucket {
  from: number;
  to: number;
  count: number;
}

export interface OfferOption {
  kind: 'keep' | 'median' | 'top';
  value: number;
  /** Перцентиль, который даст эта ставка. */
  percentile: number;
  label: string;
}

export interface CategoryStats {
  category: MspCategory | null;
  label: string;
  employers: number;
  vacancies: number;
  median: number | null;
}

export interface VacancyExample {
  id: string;
  title: string;
  employerName: string | null;
  employerInn: string | null;
  employerCategory: MspCategory | null | undefined;
  salaryMin: number | null;
  salaryMax: number | null;
  value: number;
  schedule: string | null;
  url: string | null;
}

export interface PhraseStat {
  key: string;
  label: string;
  count: number;
  share: number;
}

export interface SeasonalityWeek {
  /** Номер недели по ISO-8601, например «2026-W15». */
  week: string;
  /** Понедельник недели, YYYY-MM-DD. */
  from: string;
  /** Воскресенье недели, YYYY-MM-DD. */
  to: string;
  count: number;
  /** Доля недели в выборке, % с одним знаком. */
  share: number;
}

export interface SeasonalityMonth {
  /** Месяц в формате «2026-04». */
  month: string;
  /** Читаемая подпись, например «апрель 2026». */
  label: string;
  count: number;
  share: number;
}

export interface Seasonality {
  /** Сколько вакансий выборки имеют дату создания. */
  dated: number;
  weeks: SeasonalityWeek[];
  months: SeasonalityMonth[];
  /** Начало и конец доступного периода наблюдения, YYYY-MM-DD. */
  from: string | null;
  to: string | null;
  /** Неделя пика набора. */
  peak: SeasonalityWeek | null;
  /** Месяц пика набора. */
  peakMonth: SeasonalityMonth | null;
  /** Во сколько раз пик выше средней недели. */
  peakRatio: number | null;
}

export interface MarketCard {
  professionKey: string;
  professionTitle: string;
  regionCode: string;
  sample: {
    /** Сколько записей пришло от источника до фильтрации. */
    fetched: number;
    /** Сколько осталось после фильтра по названию, зарплате и дедупликации. */
    vacancies: number;
    /** Уникальных работодателей (по ИНН). */
    employers: number;
    /** Доля вакансий крупнейшего работодателя выборки, % (защита от «рынка одной сети»). */
    topEmployerShare: number;
    dropped: Record<string, number>;
  };
  confidence: Confidence;
  confidenceReason: string | null;
  stats: SalaryStats | null;
  /** Доля вакансий с фиксированной ставкой (min == max). */
  fixedShare: number | null;
  /** Медиана по вакансиям, созданным за последние 30 дней (если их ≥ 5). */
  recentMedian: number | null;
  offer: {
    value: number;
    percentile: number;
    band: OfferBand;
    /** Доля вакансий, где предлагают больше вашей ставки, %. */
    shareAbove: number;
  } | null;
  options: OfferOption[];
  histogram: HistogramBucket[];
  byCategory: CategoryStats[];
  /** Срез «работодатели вашего размера» – если известна категория пользователя. */
  sameSize: CategoryStats | null;
  examples: VacancyExample[];
  requirements: PhraseStat[];
  schedules: { label: string; share: number }[];
  /** Распределение вакансий по неделям публикации; null – дат в выборке слишком мало. */
  seasonality?: Seasonality | null;
  /** Готовый текстовый вердикт (детерминированный, по правилам ядра). */
  verdict: string;
}

export interface MarketInput {
  vacancies: VacancyRecord[];
  profession: Profession;
  regionCode: string;
  /** Предлагаемая ставка, ₽/мес; null – только обзор рынка. */
  offer: number | null;
  thresholds: Thresholds;
  requirementPhrases: PhraseRule[];
  /** Категория бизнеса пользователя для среза «такие же, как вы». */
  userCategory: MspCategory | null;
  /** Название региона для текста вердикта. */
  regionName: string;
  /** Дата «сегодня» (для расчёта свежих вакансий); по умолчанию – текущая. */
  now?: Date;
}

/* ────────────────────────── «Штат и удержание» ────────────────────────── */

export interface StaffPosition {
  /** Идентификатор строки штата (задаёт вызывающая сторона). */
  id: string;
  /** Название должности как его написал владелец. */
  title: string;
  /** Текущая ставка, ₽/мес до НДФЛ. */
  salary: number;
  /** Ключ профессии каталога или «custom:<slug>»; null – профессия не определена. */
  professionKey?: string | null;
}

export type StaffRisk = 'high' | 'medium' | 'none' | 'unknown';

export interface StaffAssessment {
  id: string;
  title: string;
  salary: number;
  professionKey: string | null;
  professionTitle: string | null;
  /** Перцентиль ставки на рынке региона (аппроксимация по гистограмме карточки). */
  percentile: number | null;
  band: OfferBand | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  /** Разрыв до медианы, ₽/мес (0, если ставка не ниже медианы). */
  gapRub: number;
  /** Тот же разрыв в процентах от текущей ставки. */
  gapPct: number;
  /** high – ниже 25-го перцентиля, medium – ниже медианы, none – в рынке, unknown – нет данных. */
  risk: StaffRisk;
  /** Причина, по которой оценка не сделана. */
  note: string | null;
}

export interface StaffSummary {
  positions: number;
  assessed: number;
  unknown: number;
  highRisk: number;
  mediumRisk: number;
  inMarket: number;
  /** Текущий фонд оплаты труда по внесённым позициям, ₽/мес. */
  payroll: number;
  /** Сколько стоит подтянуть всех отстающих до медианы, ₽/мес. */
  costToMedian: number;
  /** Стоимость подтягивания в процентах от фонда. */
  costShare: number;
  /** Медианный перцентиль штата. */
  medianPercentile: number | null;
}

export interface StaffReport {
  /** Позиции, отсортированные от самых отстающих к рыночным. */
  positions: StaffAssessment[];
  summary: StaffSummary;
}

/* ────────────────────────── Сравнение регионов ────────────────────────── */

export type RegionSort = 'median' | 'affordability' | 'vacancies';

export interface RegionMarketInput {
  /** Двузначный код региона ФНС. */
  fnsCode: string;
  /** 13-значный код региона «Работы России», если известен. */
  regionCode?: string | null;
  regionName: string;
  /** Средняя зарплата по региону из справочника, ₽/мес. */
  avgSalary: number | null;
  stats: SalaryStats | null;
  histogram?: HistogramBucket[];
  vacancies: number;
  employers: number;
  confidence?: Confidence | null;
  /** Причина, по которой регион не посчитан; остальные регионы это не ломает. */
  error?: string | null;
}

export interface RegionComparisonRow {
  fnsCode: string;
  regionCode: string | null;
  regionName: string;
  avgSalary: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  vacancies: number;
  employers: number;
  /** Индекс доступности: медиана профессии ÷ средняя зарплата региона. */
  affordability: number | null;
  /** Перцентиль вашей ставки в этом регионе. */
  offerPercentile: number | null;
  confidence: Confidence | null;
  error: string | null;
  /** Место в таблице после сортировки (1 – первое); 0 у регионов без данных. */
  rank: number;
}

export interface RegionComparison {
  sortBy: RegionSort;
  rows: RegionComparisonRow[];
  summary: {
    regions: number;
    withData: number;
    failed: number;
    /** Код ФНС региона с самой низкой медианой. */
    cheapest: string | null;
    mostVacancies: string | null;
    bestAffordability: string | null;
    medianMin: number | null;
    medianMax: number | null;
    spreadPct: number | null;
  };
}
