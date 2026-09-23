/**
 * Драйвер Единого реестра субъектов МСП (ФНС России).
 * https://rmsp.nalog.ru/search-proc.json?query={ИНН}&mode=quick – без авторизации, ~30 мс.
 * Пустой data[] для ИНН – не ошибка: организация не является субъектом МСП.
 */
import type { EmployerProfile, MspCategory } from '../core/types.js';
import { fetchJson } from './http.js';

export const RMSP_BASE = 'https://rmsp.nalog.ru';
export const SOURCE_ID = 'rmsp';
export const SOURCE_TITLE = 'Единый реестр субъектов МСП (ФНС России)';

export interface RmspRow {
  inn: string;
  ogrn?: string;
  category?: number;
  regioncode?: string;
  dtregistry?: string;
  dtregistryout?: string | null;
  is_active?: number;
  nptype?: 'UL' | 'IP';
  okved1?: string;
  okved1name?: string;
  name_ex?: string;
  has_licenses?: number;
  pr_soc?: number;
  token?: string;
}

interface RmspResponse { data?: RmspRow[]; rowCount?: number }

export interface BusinessProfile extends EmployerProfile {
  ogrn: string | null;
  /** Токен ФНС для скачивания выписки с ЭП (живёт недолго, не сохраняем надолго). */
  excerptToken: string | null;
  /** Есть ли запись в реестре вообще. */
  inRegistry: boolean;
  fetchedAt: string;
}

export function isValidInn(inn: string): boolean {
  if (!/^\d{10}$|^\d{12}$/.test(inn)) return false;
  const d = inn.split('').map(Number);
  const check = (coef: number[]) => coef.reduce((s, c, i) => s + c * d[i]!, 0) % 11 % 10;
  if (inn.length === 10) return check([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  return check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
}

/** Дата реестра «01.08.2016 00:00:00» → «2016-08-01». */
function isoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export function mapRow(inn: string, row: RmspRow | undefined): BusinessProfile {
  const fetchedAt = new Date().toISOString();
  if (!row) {
    return {
      inn, ogrn: null, name: '', category: null, okved: null, okvedName: null, fnsRegionCode: null, kind: null,
      registeredAt: null, active: null, excerptToken: null, inRegistry: false, fetchedAt,
    };
  }
  const cat = row.category;
  return {
    inn,
    ogrn: row.ogrn ?? null,
    name: row.name_ex ?? '',
    category: cat === 1 || cat === 2 || cat === 3 ? (cat as MspCategory) : cat === 0 ? 0 : null,
    okved: row.okved1 ?? null,
    okvedName: row.okved1name ?? null,
    fnsRegionCode: row.regioncode ?? null,
    kind: row.nptype ?? null,
    registeredAt: isoDate(row.dtregistry),
    active: row.is_active == null ? null : row.is_active === 1,
    excerptToken: row.token ?? null,
    inRegistry: true,
    fetchedAt,
  };
}

export interface FetchProfileOptions {
  /** Таймаут одного запроса, мс (по умолчанию 15 с – для профиля пользователя). */
  timeoutMs?: number;
  /** Число повторов при 5xx/таймауте (по умолчанию 2). */
  retries?: number;
}

export async function fetchBusinessProfile(inn: string, opts: FetchProfileOptions = {}): Promise<BusinessProfile> {
  const url = `${RMSP_BASE}/search-proc.json?query=${encodeURIComponent(inn)}&mode=quick`;
  const data = await fetchJson<RmspResponse>(url, { source: SOURCE_ID, timeoutMs: opts.timeoutMs ?? 15_000, retries: opts.retries ?? 2 });
  const row = data.data?.find((r) => r.inn === inn) ?? data.data?.[0];
  return mapRow(inn, row);
}

/** Официальная выписка из реестра МСП в PDF с электронной подписью ФНС. */
export async function fetchExcerptPdf(token: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${RMSP_BASE}/excerpt.pdf?token=${encodeURIComponent(token)}`, { signal: controller.signal });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('pdf')) {
      throw new Error(`rmsp excerpt: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}
