/**
 * Драйвер источника «Работа России» (Роструд), Open API v1.
 * Документация: https://trudvsem.ru/opendata/api. Без авторизации.
 * Особенности (проверены запросами 20–23.09.2026):
 *  - limit ≤ 100, offset — НОМЕР СТРАНИЦЫ (0-based), offset×limit < 10 000;
 *  - неизвестные параметры молча игнорируются → фильтруем на своей стороне;
 *  - одна страница может целиком состоять из объявлений одного работодателя → дедупликация в ядре;
 *  - латентность 6–11 с на страницу, параллельные запросы не замедляют друг друга;
 *  - в JSON встречаются недопустимые escape-последовательности → parseJsonLenient.
 */
import type { VacancyRecord } from '../core/types.js';
import { fetchJson } from './http.js';

export const TRUDVSEM_BASE = 'https://opendata.trudvsem.ru/api/v1';
export const SOURCE_ID = 'trudvsem';
export const SOURCE_TITLE = '«Работа России» (Роструд)';

export interface RawVacancy {
  id: string;
  'job-name'?: string;
  typicalPosition?: string | null;
  code_profession?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  salary?: string | null;
  company?: { inn?: string; ogrn?: string; name?: string; companycode?: string; 'hr-agency'?: boolean } | null;
  region?: { region_code?: string; name?: string } | null;
  schedule?: string | null;
  employment?: string | null;
  /** Текст требований. */
  requirements?: string | null;
  /** Структурированные требования: образование и опыт (лет). */
  requirement?: { education?: string | null; experience?: number | null } | null;
  duty?: string | null;
  medicalDocuments?: string | null;
  work_places?: number | null;
  vac_url?: string | null;
  'creation-date'?: string | null;
  date_modify?: string | null;
  addresses?: { address?: { lat?: number | string; lng?: number | string; location?: string }[] } | null;
}

interface RawResponse {
  status?: string;
  meta?: { total?: number; limit?: number };
  results?: { vacancies?: { vacancy: RawVacancy }[] } | null;
}

const num = (x: unknown): number | null => (x == null || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null);

export function mapVacancy(raw: RawVacancy, regionCode: string): VacancyRecord {
  const addr = raw.addresses?.address?.[0];
  const reqParts = [raw.requirements, raw.medicalDocuments ? `Медицинские документы: ${raw.medicalDocuments}` : null].filter(Boolean);
  return {
    id: raw.id,
    title: (raw['job-name'] ?? '').trim(),
    typicalPosition: raw.typicalPosition?.trim() || null,
    codeProfession: raw.code_profession ?? null,
    salaryMin: num(raw.salary_min),
    salaryMax: num(raw.salary_max),
    employerInn: raw.company?.inn?.trim() || null,
    employerOgrn: raw.company?.ogrn?.trim() || null,
    employerName: raw.company?.name?.trim() || null,
    regionCode: raw.region?.region_code ?? regionCode,
    schedule: raw.schedule ?? null,
    employment: raw.employment ?? null,
    requirement: reqParts.length ? reqParts.join('. ') : null,
    duty: raw.duty ?? null,
    experienceYears: num(raw.requirement?.experience),
    education: raw.requirement?.education ?? null,
    workPlaces: num(raw.work_places),
    hrAgency: raw.company?.['hr-agency'] === true,
    url: raw.vac_url ?? null,
    createdAt: raw['creation-date'] ?? null,
    modifiedAt: raw.date_modify ?? null,
    lat: num(addr?.lat),
    lng: num(addr?.lng),
  };
}

export interface FetchVacanciesOptions {
  regionCode: string;
  text: string;
  /** Максимум записей (по 100 на страницу). */
  maxRecords?: number;
  /** Сколько страниц запрашивать параллельно. */
  concurrency?: number;
  fetchImpl?: typeof fetchPage;
  onProgress?: (done: number, total: number) => void;
}

export interface FetchVacanciesResult {
  total: number;
  vacancies: VacancyRecord[];
  pages: number;
  fetchedAt: string;
}

export async function fetchPage(regionCode: string, text: string, page: number, limit = 100): Promise<{ total: number; items: RawVacancy[] }> {
  const base = regionCode === 'all' ? `${TRUDVSEM_BASE}/vacancies` : `${TRUDVSEM_BASE}/vacancies/region/${encodeURIComponent(regionCode)}`;
  const url = `${base}?text=${encodeURIComponent(text)}&limit=${limit}&offset=${page}`;
  const data = await fetchJson<RawResponse>(url, { source: SOURCE_ID, timeoutMs: 30_000, retries: 1 });
  const items = data.results?.vacancies?.map((x) => x.vacancy) ?? [];
  return { total: data.meta?.total ?? items.length, items };
}

/** Загружает страницы по региону и тексту запроса (до maxRecords): первую синхронно, остальные параллельно. */
export async function fetchVacancies(opts: FetchVacanciesOptions): Promise<FetchVacanciesResult> {
  const limit = 100;
  const maxRecords = Math.min(opts.maxRecords ?? 1000, 9_900);
  const concurrency = opts.concurrency ?? 4;
  const fetcher = opts.fetchImpl ?? fetchPage;
  const first = await fetcher(opts.regionCode, opts.text, 0, limit);
  const total = first.total;
  const wanted = Math.min(total, maxRecords);
  const pages = Math.max(1, Math.ceil(wanted / limit));
  opts.onProgress?.(1, pages);
  const collected: RawVacancy[][] = [first.items];
  const remaining = Array.from({ length: pages - 1 }, (_, i) => i + 1);
  let done = 1;
  for (let i = 0; i < remaining.length; i += concurrency) {
    const batch = remaining.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((p) => fetcher(opts.regionCode, opts.text, p, limit).then((r) => r.items).catch(() => [])));
    collected.push(...results);
    done += batch.length;
    opts.onProgress?.(done, pages);
  }
  const seen = new Set<string>();
  const vacancies: VacancyRecord[] = [];
  for (const raw of collected.flat()) {
    if (!raw?.id || seen.has(raw.id)) continue;
    seen.add(raw.id);
    vacancies.push(mapVacancy(raw, opts.regionCode));
  }
  return { total, vacancies, pages, fetchedAt: new Date().toISOString() };
}
