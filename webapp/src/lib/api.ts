/** Клиент API сервера «Ставки». Токен сессии выдаётся после проверки initData на сервере. */
import { webApp } from './bridge';

let token: string | null = null;

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = 'ApiError'; }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, d.error ?? 'http_error', d.message ?? `Ошибка ${res.status}`);
  }
  return data as T;
}

export interface SessionInfo { token: string; user: { id: number; name: string | null; demo: boolean; chatId: number | null }; startParam: string | null }

export async function openSession(): Promise<SessionInfo> {
  const initData = webApp()?.initData || undefined;
  const s = await request<SessionInfo>('POST', '/api/session', { initData });
  token = s.token;
  return s;
}

export interface Region { fnsCode: string; code: string; name: string; avgSalary: number | null }
export interface ProfessionRef { key: string; title: string }
export interface PackRef { id: string; title: string; version: number; region: { fnsCode: string; name: string } | null; industry: { okvedPrefixes: string[]; title: string } | null; professions: ProfessionRef[]; demo: { inn: string; profession: string; salary: number; note?: string } | null }
export interface Profile { inn: string; name: string; category: 0 | 1 | 2 | 3 | null; okved: string | null; okvedName: string | null; fnsRegionCode: string | null; kind: 'UL' | 'IP' | null; registeredAt: string | null; active: boolean | null; inRegistry: boolean; fetchedAt: string }
export interface Bootstrap {
  bot: { username: string; link: string } | null;
  packs: PackRef[];
  regions: Region[];
  professions: ProfessionRef[];
  user: { id: number; name: string | null; demo: boolean; chatId: number | null; inn: string | null; regionFnsCode: string | null; profile: Profile | null; pack: { id: string; title: string } };
  recentCards: { id: string; professionKey: string; professionTitle: string; regionName: string; offer: number | null; median: number | null; createdAt: string }[];
  sources: { id: string; title: string; url: string; kind: string }[];
}

export interface SalaryStats { n: number; median: number; p25: number; p75: number; min: number; max: number; mean: number }
export interface MarketCard {
  professionKey: string; professionTitle: string; regionCode: string;
  sample: { fetched: number; vacancies: number; employers: number; topEmployerShare: number; dropped: Record<string, number> };
  confidence: 'ok' | 'low' | 'none'; confidenceReason: string | null;
  stats: SalaryStats | null; fixedShare: number | null; recentMedian: number | null;
  offer: { value: number; percentile: number; band: 'low' | 'below_median' | 'market' | 'above'; shareAbove: number } | null;
  options: { kind: 'keep' | 'median' | 'top'; value: number; percentile: number; label: string }[];
  histogram: { from: number; to: number; count: number }[];
  byCategory: { category: 0 | 1 | 2 | 3 | null; label: string; employers: number; vacancies: number; median: number | null }[];
  sameSize: { category: 0 | 1 | 2 | 3 | null; label: string; employers: number; vacancies: number; median: number | null } | null;
  examples: { id: string; title: string; employerName: string | null; employerInn: string | null; employerCategory?: 0 | 1 | 2 | 3 | null; salaryMin: number | null; salaryMax: number | null; value: number; schedule: string | null; url: string | null }[];
  requirements: { key: string; label: string; count: number; share: number }[];
  schedules: { label: string; share: number }[];
  verdict: string;
}
export interface MarketResult {
  cardId: string; card: MarketCard; pack: { id: string; title: string; version: number };
  profession: ProfessionRef & { query: string }; region: Region; profile: Profile | null;
  sources: { id: string; title: string; url: string; fetchedAt: string; note?: string }[];
  fetched: { total: number; records: number; cacheHit: boolean; fetchedAt: string };
  closure: { observedDays: number; total: number; closedAbove: number; totalAbove: number; closedBelow: number; totalBelow: number } | null;
  createdAt: string;
}

/* ---------- отклики и найм ---------- */
export type VacancyStatus = 'open' | 'closed';
export type ResponseStatus = 'new' | 'invited' | 'rejected' | 'hired';

export interface VacancyView {
  id: string; cardId: string | null; title: string; professionKey: string; regionCode: string; regionName: string;
  salary: number | null; text: string; employerName: string | null; status: VacancyStatus;
  createdAt: string; closedAt: string | null; hiredResponseId: string | null; firstResponseAt: string | null;
  responses: number; newResponses: number; link: string | null;
  metrics: { timeToFirstResponseMin: number | null; timeToHireMin: number | null };
}

export interface CandidateAnswers { experience: 'none' | 'lt1' | 'mid' | 'senior'; schedule: boolean; expectedSalary: number | null }

export interface ResponseView {
  id: string; vacancyId: string; candidateName: string | null; answers: CandidateAnswers; experienceLabel: string;
  phone: string | null; phoneVerified: boolean; score: number; maxScore: number; status: ResponseStatus;
  createdAt: string; updatedAt: string;
}

export const api = {
  bootstrap: () => request<Bootstrap>('GET', '/api/bootstrap'),
  profile: (inn: string) => request<{ profile: Profile; region: Region | null; pack: { id: string; title: string; professions: ProfessionRef[] } }>('POST', '/api/profile', { inn }),
  market: (p: { inn?: string | null; regionFnsCode?: string | null; professionKey: string; offer?: number | null; forceRefresh?: boolean }) => request<MarketResult>('POST', '/api/market', p),
  card: (id: string) => request<MarketResult>('GET', `/api/cards/${encodeURIComponent(id)}`),
  report: (id: string) => request<{ mid: string; chatType: 'DIALOG' | 'CHAT'; reused: boolean }>('POST', `/api/cards/${encodeURIComponent(id)}/report`),
  subscribe: (id: string) => request<{ subscription: { id: string } }>('POST', `/api/cards/${encodeURIComponent(id)}/subscribe`),
  vacancyText: (id: string, salary?: number) => request<{ text: string; salary: number }>('POST', `/api/cards/${encodeURIComponent(id)}/vacancy-text`, { salary }),
  subscriptions: () => request<{ subscriptions: { id: string; professionTitle: string; regionName: string; offer: number | null; lastMedian: number | null }[] }>('GET', '/api/subscriptions'),
  unsubscribe: (id: string) => request<{ ok: boolean }>('DELETE', `/api/subscriptions/${encodeURIComponent(id)}`),
  publishVacancy: (cardId: string, body: { salary?: number | null; text?: string }) =>
    request<{ vacancy: VacancyView; link: string; qrSent: boolean }>('POST', `/api/cards/${encodeURIComponent(cardId)}/vacancy`, body),
  vacancies: () => request<{ vacancies: VacancyView[]; demo: boolean }>('GET', '/api/vacancies'),
  vacancyResponses: (id: string) => request<{ vacancy: VacancyView; responses: ResponseView[] }>('GET', `/api/vacancies/${encodeURIComponent(id)}/responses`),
  invite: (responseId: string, message: string) => request<{ response: ResponseView }>('POST', `/api/responses/${encodeURIComponent(responseId)}/invite`, { message }),
  reject: (responseId: string) => request<{ response: ResponseView }>('POST', `/api/responses/${encodeURIComponent(responseId)}/reject`, {}),
  hire: (responseId: string) => request<{ response: ResponseView; vacancy: VacancyView }>('POST', `/api/responses/${encodeURIComponent(responseId)}/hire`, {}),
  closeVacancy: (id: string) => request<{ vacancy: VacancyView }>('POST', `/api/vacancies/${encodeURIComponent(id)}/close`, {}),
};

export const rub = (v: number) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;
export const fmtDate = (iso: string) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const categoryLabel = (c: 0 | 1 | 2 | 3 | null | undefined) => (c === 1 ? 'микропредприятие' : c === 2 ? 'малое предприятие' : c === 3 ? 'среднее предприятие' : 'не МСП');

/** Длительность в минутах → «12 мин», «3 ч 20 мин», «2 дн 4 ч». */
export const fmtDuration = (minutes: number | null): string => {
  if (minutes == null) return '—';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч${minutes % 60 ? ` ${minutes % 60} мин` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days} дн${hours % 24 ? ` ${hours % 24} ч` : ''}`;
};

export const responseStatusLabel = (s: ResponseStatus): string =>
  (s === 'new' ? 'новый' : s === 'invited' ? 'приглашён' : s === 'rejected' ? 'отказ' : 'нанят');
