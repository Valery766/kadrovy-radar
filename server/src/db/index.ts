/**
 * Хранилище на встроенном SQLite (node:sqlite, Node ≥ 22.13): без внешних служб,
 * один файл в DATA_DIR. Таблицы: кэш источников, профили бизнеса, пользователи и
 * состояние диалога, карточки рынка, отчёты, подписки, идемпотентность вебхука.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Кэш выдачи «Работы России»: ключ = регион + запрос; payload – массив VacancyRecord (JSON).
CREATE TABLE IF NOT EXISTS vacancy_cache (
  cache_key TEXT PRIMARY KEY,
  region_code TEXT NOT NULL,
  query TEXT NOT NULL,
  total INTEGER NOT NULL,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- Наблюдения за вакансиями для оценки «за сколько закрывается»: первое и последнее появление.
CREATE TABLE IF NOT EXISTS vacancy_seen (
  vacancy_id TEXT PRIMARY KEY,
  region_code TEXT NOT NULL,
  profession_key TEXT NOT NULL,
  employer_inn TEXT,
  value INTEGER,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vacancy_seen_key ON vacancy_seen(region_code, profession_key);

-- Профили работодателей и пользователей из реестра МСП (по ИНН).
CREATE TABLE IF NOT EXISTS business_profiles (
  inn TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- Пользователь MAX: выбранный ИНН, регион, пакет, последний запрос.
CREATE TABLE IF NOT EXISTS users (
  max_user_id INTEGER PRIMARY KEY,
  name TEXT,
  username TEXT,
  chat_id INTEGER,
  inn TEXT,
  region_fns_code TEXT,
  pack_id TEXT,
  state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Карточки рынка: результат расчёта, чтобы делиться ссылкой и открывать из чата.
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  max_user_id INTEGER,
  inn TEXT,
  pack_id TEXT NOT NULL,
  profession_key TEXT NOT NULL,
  region_code TEXT NOT NULL,
  offer INTEGER,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(max_user_id, created_at);

-- Отчёты PDF, отправленные ботом (mid нужен для пересылки через shareMaxContent).
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  max_user_id INTEGER NOT NULL,
  chat_id INTEGER,
  mid TEXT,
  file_path TEXT,
  created_at TEXT NOT NULL
);

-- Подписки «следить за ставкой»: раз в неделю сравниваем медиану.
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  max_user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  pack_id TEXT NOT NULL,
  profession_key TEXT NOT NULL,
  region_code TEXT NOT NULL,
  offer INTEGER,
  last_median INTEGER,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subs_unique ON subscriptions(max_user_id, profession_key, region_code);

-- Опубликованные вакансии: карточка вакансии в MAX (диплинк + QR) и её жизненный цикл.
CREATE TABLE IF NOT EXISTS vacancies (
  id TEXT PRIMARY KEY,
  max_user_id INTEGER NOT NULL,
  card_id TEXT,
  profession_key TEXT NOT NULL,
  region_code TEXT NOT NULL,
  title TEXT NOT NULL,
  salary INTEGER,
  text TEXT NOT NULL,
  employer_name TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  closed_at TEXT,
  hired_response_id TEXT,
  first_response_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_vacancies_user ON vacancies(max_user_id, created_at);

-- Отклики кандидатов: ответы на три вопроса, номер (если поделился) и статус.
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  vacancy_id TEXT NOT NULL,
  candidate_user_id INTEGER NOT NULL,
  candidate_name TEXT,
  answers TEXT NOT NULL,
  phone TEXT,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responses_vacancy ON responses(vacancy_id, created_at);

-- Идемпотентность вебхука: MAX может доставить одно событие до 10 раз.
CREATE TABLE IF NOT EXISTS updates_seen (
  update_key TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- Плановые КНМ из ЕРКНМ (Генпрокуратура): одна строка на пару «мероприятие × субъект».
CREATE TABLE IF NOT EXISTS inspections (
  id TEXT PRIMARY KEY,
  dataset_year INTEGER NOT NULL,
  erp_id TEXT NOT NULL,
  inn TEXT,
  ogrn TEXT,
  subject_name TEXT,
  subject_type TEXT,
  msp_code TEXT,
  okved TEXT,
  okved2 TEXT,
  kind TEXT NOT NULL,
  kind_control TEXT,
  kind_knm TEXT,
  type_name TEXT,
  status TEXT,
  start_date TEXT,
  stop_date TEXT,
  organization TEXT,
  prosecutor_office TEXT,
  address TEXT,
  region_code TEXT,
  region_fns_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_inspections_inn ON inspections(inn);
CREATE INDEX IF NOT EXISTS idx_inspections_context ON inspections(region_code, okved2, kind);

-- Версия загруженного набора ЕРКНМ: по ней решаем, нужна ли перезаливка.
-- loaded_at – когда набор загружен или последний раз подтверждён как актуальный.
CREATE TABLE IF NOT EXISTS inspection_datasets (
  year INTEGER PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  version TEXT NOT NULL,
  file_name TEXT NOT NULL,
  records INTEGER NOT NULL,
  with_region INTEGER NOT NULL,
  loaded_at TEXT NOT NULL
);

-- Голосования в чате по вариантам ставки (message mid → выбор участника).
CREATE TABLE IF NOT EXISTS votes (
  mid TEXT NOT NULL,
  max_user_id INTEGER NOT NULL,
  option_kind TEXT NOT NULL,
  voted_at TEXT NOT NULL,
  PRIMARY KEY (mid, max_user_id)
);
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Старые вакансии остаются доступными только по своей ссылке: каталог требует явного действия владельца.
  const columns = db.prepare('PRAGMA table_info(vacancies)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'listed')) db.exec('ALTER TABLE vacancies ADD COLUMN listed INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_vacancies_catalog ON vacancies(listed, status, region_code, created_at)');
  // SQLite lower() без ICU не меняет регистр кириллицы. Поиск остаётся параметризованным.
  db.function('search_fold', { deterministic: true }, (value) => String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е'));
  return db;
}

export const nowIso = () => new Date().toISOString();

/* ---------- кэш вакансий ---------- */
export interface VacancyCacheRow<T> { cacheKey: string; regionCode: string; query: string; total: number; payload: T; fetchedAt: string }

export function getVacancyCache<T>(db: Db, cacheKey: string): VacancyCacheRow<T> | null {
  const row = db.prepare('SELECT cache_key, region_code, query, total, payload, fetched_at FROM vacancy_cache WHERE cache_key = ?').get(cacheKey) as
    | { cache_key: string; region_code: string; query: string; total: number; payload: string; fetched_at: string } | undefined;
  if (!row) return null;
  return { cacheKey: row.cache_key, regionCode: row.region_code, query: row.query, total: row.total, payload: JSON.parse(row.payload) as T, fetchedAt: row.fetched_at };
}

export function putVacancyCache(db: Db, row: { cacheKey: string; regionCode: string; query: string; total: number; payload: unknown; fetchedAt: string }): void {
  db.prepare('INSERT OR REPLACE INTO vacancy_cache (cache_key, region_code, query, total, payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.cacheKey, row.regionCode, row.query, row.total, JSON.stringify(row.payload), row.fetchedAt);
}

/* ---------- наблюдения за вакансиями ---------- */
export function recordVacancySeen(db: Db, regionCode: string, professionKey: string, items: { id: string; employerInn: string | null; value: number | null }[], seenAt: string): void {
  const stmt = db.prepare(`INSERT INTO vacancy_seen (vacancy_id, region_code, profession_key, employer_inn, value, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(vacancy_id) DO UPDATE SET last_seen = excluded.last_seen`);
  const tx = db.prepare('BEGIN'); const commit = db.prepare('COMMIT');
  tx.run();
  try {
    for (const it of items) stmt.run(it.id, regionCode, professionKey, it.employerInn, it.value == null ? null : Math.round(it.value), seenAt, seenAt);
    commit.run();
  } catch (e) { db.prepare('ROLLBACK').run(); throw e; }
}

export interface ClosureStats { observedDays: number; total: number; closedAbove: number; totalAbove: number; closedBelow: number; totalBelow: number }

/** Доля вакансий, исчезнувших из выдачи за период наблюдения, выше и ниже медианы. */
export function closureStats(db: Db, regionCode: string, professionKey: string, median: number, lastSyncAt: string): ClosureStats | null {
  const rows = db.prepare('SELECT value, first_seen, last_seen FROM vacancy_seen WHERE region_code = ? AND profession_key = ? AND value IS NOT NULL').all(regionCode, professionKey) as { value: number; first_seen: string; last_seen: string }[];
  if (rows.length === 0) return null;
  const firstSeen = rows.reduce((min, r) => (r.first_seen < min ? r.first_seen : min), rows[0]!.first_seen);
  const observedDays = Math.max(0, Math.round((Date.parse(lastSyncAt) - Date.parse(firstSeen)) / 86400_000));
  const closed = (r: { last_seen: string }) => r.last_seen < lastSyncAt.slice(0, 10);
  const above = rows.filter((r) => r.value >= median); const below = rows.filter((r) => r.value < median);
  return {
    observedDays, total: rows.length,
    closedAbove: above.filter(closed).length, totalAbove: above.length,
    closedBelow: below.filter(closed).length, totalBelow: below.length,
  };
}

/* ---------- профили бизнеса ---------- */
export function getBusinessProfile<T>(db: Db, inn: string): { payload: T; fetchedAt: string } | null {
  const row = db.prepare('SELECT payload, fetched_at FROM business_profiles WHERE inn = ?').get(inn) as { payload: string; fetched_at: string } | undefined;
  return row ? { payload: JSON.parse(row.payload) as T, fetchedAt: row.fetched_at } : null;
}
export function putBusinessProfile(db: Db, inn: string, payload: unknown, fetchedAt: string): void {
  db.prepare('INSERT OR REPLACE INTO business_profiles (inn, payload, fetched_at) VALUES (?, ?, ?)').run(inn, JSON.stringify(payload), fetchedAt);
}

/* ---------- пользователи ---------- */
export interface UserRow { maxUserId: number; name: string | null; username: string | null; chatId: number | null; inn: string | null; regionFnsCode: string | null; packId: string | null; state: Record<string, unknown>; createdAt: string; updatedAt: string }

export function getUser(db: Db, maxUserId: number): UserRow | null {
  const r = db.prepare('SELECT * FROM users WHERE max_user_id = ?').get(maxUserId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return { maxUserId: r.max_user_id as number, name: r.name as string | null, username: r.username as string | null, chatId: r.chat_id as number | null, inn: r.inn as string | null, regionFnsCode: r.region_fns_code as string | null, packId: r.pack_id as string | null, state: JSON.parse(r.state as string), createdAt: r.created_at as string, updatedAt: r.updated_at as string };
}

export function upsertUser(db: Db, u: { maxUserId: number; name?: string | null; username?: string | null; chatId?: number | null }): UserRow {
  const now = nowIso();
  db.prepare(`INSERT INTO users (max_user_id, name, username, chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(max_user_id) DO UPDATE SET name = COALESCE(excluded.name, users.name), username = COALESCE(excluded.username, users.username), chat_id = COALESCE(excluded.chat_id, users.chat_id), updated_at = excluded.updated_at`)
    .run(u.maxUserId, u.name ?? null, u.username ?? null, u.chatId ?? null, now, now);
  return getUser(db, u.maxUserId)!;
}

export function updateUser(db: Db, maxUserId: number, patch: Partial<Pick<UserRow, 'inn' | 'regionFnsCode' | 'packId' | 'state' | 'chatId'>>): void {
  const cur = getUser(db, maxUserId);
  if (!cur) return;
  db.prepare('UPDATE users SET inn = ?, region_fns_code = ?, pack_id = ?, state = ?, chat_id = ?, updated_at = ? WHERE max_user_id = ?')
    .run(patch.inn === undefined ? cur.inn : patch.inn, patch.regionFnsCode === undefined ? cur.regionFnsCode : patch.regionFnsCode, patch.packId === undefined ? cur.packId : patch.packId, JSON.stringify(patch.state ?? cur.state), patch.chatId === undefined ? cur.chatId : patch.chatId, nowIso(), maxUserId);
}

/* ---------- карточки ---------- */
export interface CardRow<T> { id: string; maxUserId: number | null; inn: string | null; packId: string; professionKey: string; regionCode: string; offer: number | null; payload: T; createdAt: string }

export function putCard(db: Db, c: { id: string; maxUserId: number | null; inn: string | null; packId: string; professionKey: string; regionCode: string; offer: number | null; payload: unknown }): void {
  db.prepare('INSERT INTO cards (id, max_user_id, inn, pack_id, profession_key, region_code, offer, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c.id, c.maxUserId, c.inn, c.packId, c.professionKey, c.regionCode, c.offer, JSON.stringify(c.payload), nowIso());
}
export function getCard<T>(db: Db, id: string): CardRow<T> | null {
  const r = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  return { id: r.id as string, maxUserId: r.max_user_id as number | null, inn: r.inn as string | null, packId: r.pack_id as string, professionKey: r.profession_key as string, regionCode: r.region_code as string, offer: r.offer as number | null, payload: JSON.parse(r.payload as string) as T, createdAt: r.created_at as string };
}
export function listCardsByUser<T>(db: Db, maxUserId: number, limit = 10): CardRow<T>[] {
  const rows = db.prepare('SELECT id FROM cards WHERE max_user_id = ? ORDER BY created_at DESC LIMIT ?').all(maxUserId, limit) as { id: string }[];
  return rows.map((r) => getCard<T>(db, r.id)!).filter(Boolean);
}

/* ---------- отчёты ---------- */
export function putReport(db: Db, r: { id: string; cardId: string; maxUserId: number; chatId: number | null; mid: string | null; filePath: string | null }): void {
  db.prepare('INSERT OR REPLACE INTO reports (id, card_id, max_user_id, chat_id, mid, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(r.id, r.cardId, r.maxUserId, r.chatId, r.mid, r.filePath, nowIso());
}
export function getReportByCard(db: Db, cardId: string, maxUserId: number): { id: string; mid: string | null; chatId: number | null; filePath: string | null; createdAt: string } | null {
  const r = db.prepare('SELECT id, mid, chat_id, file_path, created_at FROM reports WHERE card_id = ? AND max_user_id = ? ORDER BY created_at DESC LIMIT 1').get(cardId, maxUserId) as Record<string, unknown> | undefined;
  return r ? { id: r.id as string, mid: r.mid as string | null, chatId: r.chat_id as number | null, filePath: r.file_path as string | null, createdAt: r.created_at as string } : null;
}

/* ---------- подписки ---------- */
export interface SubscriptionRow { id: string; maxUserId: number; chatId: number; packId: string; professionKey: string; regionCode: string; offer: number | null; lastMedian: number | null; lastCheckedAt: string | null; createdAt: string; active: boolean }
function mapSub(r: Record<string, unknown>): SubscriptionRow {
  return { id: r.id as string, maxUserId: r.max_user_id as number, chatId: r.chat_id as number, packId: r.pack_id as string, professionKey: r.profession_key as string, regionCode: r.region_code as string, offer: r.offer as number | null, lastMedian: r.last_median as number | null, lastCheckedAt: r.last_checked_at as string | null, createdAt: r.created_at as string, active: (r.active as number) === 1 };
}
export function upsertSubscription(db: Db, s: { id: string; maxUserId: number; chatId: number; packId: string; professionKey: string; regionCode: string; offer: number | null; lastMedian: number | null }): SubscriptionRow {
  db.prepare(`INSERT INTO subscriptions (id, max_user_id, chat_id, pack_id, profession_key, region_code, offer, last_median, last_checked_at, created_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(max_user_id, profession_key, region_code) DO UPDATE SET chat_id = excluded.chat_id, offer = excluded.offer, last_median = excluded.last_median, last_checked_at = excluded.last_checked_at, active = 1`)
    .run(s.id, s.maxUserId, s.chatId, s.packId, s.professionKey, s.regionCode, s.offer, s.lastMedian, nowIso(), nowIso());
  return mapSub(db.prepare('SELECT * FROM subscriptions WHERE max_user_id = ? AND profession_key = ? AND region_code = ?').get(s.maxUserId, s.professionKey, s.regionCode) as Record<string, unknown>);
}
export function listActiveSubscriptions(db: Db): SubscriptionRow[] {
  return (db.prepare('SELECT * FROM subscriptions WHERE active = 1').all() as Record<string, unknown>[]).map(mapSub);
}
export function listUserSubscriptions(db: Db, maxUserId: number): SubscriptionRow[] {
  return (db.prepare('SELECT * FROM subscriptions WHERE active = 1 AND max_user_id = ? ORDER BY created_at DESC LIMIT 20').all(maxUserId) as Record<string, unknown>[]).map(mapSub);
}
export function deactivateSubscription(db: Db, id: string, maxUserId: number): boolean {
  const r = db.prepare('UPDATE subscriptions SET active = 0 WHERE id = ? AND max_user_id = ?').run(id, maxUserId);
  return r.changes > 0;
}
export function touchSubscription(db: Db, id: string, lastMedian: number | null): void {
  db.prepare('UPDATE subscriptions SET last_median = ?, last_checked_at = ? WHERE id = ?').run(lastMedian, nowIso(), id);
}

/* ---------- вакансии и отклики ---------- */
export type VacancyStatus = 'open' | 'closed';
export type ResponseStatus = 'new' | 'invited' | 'rejected' | 'hired';

export interface VacancyRow {
  id: string;
  maxUserId: number;
  cardId: string | null;
  professionKey: string;
  regionCode: string;
  title: string;
  salary: number | null;
  text: string;
  employerName: string | null;
  status: VacancyStatus;
  createdAt: string;
  closedAt: string | null;
  hiredResponseId: string | null;
  firstResponseAt: string | null;
  listed: boolean;
}

export interface ResponseRow<A = Record<string, unknown>> {
  id: string;
  vacancyId: string;
  candidateUserId: number;
  candidateName: string | null;
  answers: A;
  phone: string | null;
  phoneVerified: boolean;
  score: number;
  status: ResponseStatus;
  createdAt: string;
  updatedAt: string;
}

function mapVacancy(r: Record<string, unknown>): VacancyRow {
  return {
    id: r.id as string, maxUserId: r.max_user_id as number, cardId: r.card_id as string | null,
    professionKey: r.profession_key as string, regionCode: r.region_code as string, title: r.title as string,
    salary: r.salary as number | null, text: r.text as string, employerName: r.employer_name as string | null,
    status: r.status as VacancyStatus, createdAt: r.created_at as string, closedAt: r.closed_at as string | null,
    hiredResponseId: r.hired_response_id as string | null, firstResponseAt: r.first_response_at as string | null,
    listed: r.listed === 1,
  };
}

function mapResponse<A>(r: Record<string, unknown>): ResponseRow<A> {
  return {
    id: r.id as string, vacancyId: r.vacancy_id as string, candidateUserId: r.candidate_user_id as number,
    candidateName: r.candidate_name as string | null, answers: JSON.parse(r.answers as string) as A,
    phone: r.phone as string | null, phoneVerified: (r.phone_verified as number) === 1, score: r.score as number,
    status: r.status as ResponseStatus, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}

export function putVacancy(db: Db, v: { id: string; maxUserId: number; cardId: string | null; professionKey: string; regionCode: string; title: string; salary: number | null; text: string; employerName: string | null; listed?: boolean }): VacancyRow {
  db.prepare('INSERT INTO vacancies (id, max_user_id, card_id, profession_key, region_code, title, salary, text, employer_name, status, created_at, listed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, \'open\', ?, ?)')
    .run(v.id, v.maxUserId, v.cardId, v.professionKey, v.regionCode, v.title, v.salary, v.text, v.employerName, nowIso(), v.listed ? 1 : 0);
  return getVacancy(db, v.id)!;
}

export function getVacancy(db: Db, id: string): VacancyRow | null {
  const r = db.prepare('SELECT * FROM vacancies WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? mapVacancy(r) : null;
}

export interface JobFilters { q?: string; regionCode?: string; minSalary?: number; offset?: number; limit?: number }

/** Только добровольно размещённые открытые вакансии. Публичный DTO собирается отдельно от инбокса. */
export function listOpenJobs(db: Db, filters: JobFilters = {}): { vacancies: VacancyRow[]; total: number } {
  const q = (filters.q ?? '').trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
  const where = "listed = 1 AND status = 'open' AND (? = '' OR instr(search_fold(title), ?) > 0) AND (? = '' OR region_code = ?) AND (? = 0 OR salary >= ?)";
  const args = [q, q, filters.regionCode ?? '', filters.regionCode ?? '', filters.minSalary ?? 0, filters.minSalary ?? 0];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM vacancies WHERE ${where}`).get(...args) as { n: number }).n;
  const limit = Math.max(1, Math.min(50, filters.limit ?? 12));
  const offset = Math.max(0, filters.offset ?? 0);
  const rows = db.prepare(`SELECT * FROM vacancies WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Record<string, unknown>[];
  return { vacancies: rows.map(mapVacancy), total };
}

export function setVacancyListed(db: Db, id: string, uid: number, listed: boolean): VacancyRow | null {
  const result = db.prepare("UPDATE vacancies SET listed = ? WHERE id = ? AND max_user_id = ? AND status = 'open'").run(listed ? 1 : 0, id, uid);
  return result.changes ? getVacancy(db, id) : null;
}

/** Вакансии пользователя с числом откликов (всего и новых) – для списка «Мои вакансии». */
export function listVacanciesByUser(db: Db, maxUserId: number, limit = 50): (VacancyRow & { responses: number; newResponses: number })[] {
  const rows = db.prepare(`SELECT v.*,
      (SELECT COUNT(*) FROM responses r WHERE r.vacancy_id = v.id) AS responses_total,
      (SELECT COUNT(*) FROM responses r WHERE r.vacancy_id = v.id AND r.status = 'new') AS responses_new
    FROM vacancies v WHERE v.max_user_id = ? ORDER BY v.created_at DESC LIMIT ?`).all(maxUserId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({ ...mapVacancy(r), responses: r.responses_total as number, newResponses: r.responses_new as number }));
}

export function countResponses(db: Db, vacancyId: string): { total: number; fresh: number } {
  const r = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS fresh FROM responses WHERE vacancy_id = ?").get(vacancyId) as { total: number; fresh: number | null };
  return { total: r.total, fresh: r.fresh ?? 0 };
}

export function closeVacancy(db: Db, id: string, maxUserId: number, hiredResponseId: string | null = null): VacancyRow | null {
  const current = getVacancy(db, id);
  if (!current || current.maxUserId !== maxUserId) return null;
  if (current.status === 'closed') return hiredResponseId === null || hiredResponseId === current.hiredResponseId ? current : null;
  if (hiredResponseId && getResponse(db, hiredResponseId)?.vacancyId !== id) return null;
  const res = db.prepare("UPDATE vacancies SET status = 'closed', closed_at = COALESCE(closed_at, ?), hired_response_id = COALESCE(?, hired_response_id) WHERE id = ? AND max_user_id = ? AND status = 'open'")
    .run(nowIso(), hiredResponseId, id, maxUserId);
  return res.changes > 0 ? getVacancy(db, id) : null;
}

/** Отметить время первого отклика – метрика «время до первого отклика» (ставится один раз). */
export function markFirstResponse(db: Db, vacancyId: string, at: string): void {
  db.prepare('UPDATE vacancies SET first_response_at = COALESCE(first_response_at, ?) WHERE id = ?').run(at, vacancyId);
}

export function putResponse<A = Record<string, unknown>>(db: Db, r: { id: string; vacancyId: string; candidateUserId: number; candidateName: string | null; answers: unknown; phone: string | null; phoneVerified: boolean; score: number }): ResponseRow<A> {
  const now = nowIso();
  db.prepare('INSERT INTO responses (id, vacancy_id, candidate_user_id, candidate_name, answers, phone, phone_verified, score, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'new\', ?, ?)')
    .run(r.id, r.vacancyId, r.candidateUserId, r.candidateName, JSON.stringify(r.answers), r.phone, r.phoneVerified ? 1 : 0, Math.round(r.score), now, now);
  markFirstResponse(db, r.vacancyId, now);
  return getResponse<A>(db, r.id)!;
}

export function getResponse<A = Record<string, unknown>>(db: Db, id: string): ResponseRow<A> | null {
  const r = db.prepare('SELECT * FROM responses WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? mapResponse<A>(r) : null;
}

/** Отклики по вакансии: по убыванию совпадения, при равенстве – раньше пришедшие выше. */
export function listResponsesByVacancy<A = Record<string, unknown>>(db: Db, vacancyId: string): ResponseRow<A>[] {
  const rows = db.prepare('SELECT * FROM responses WHERE vacancy_id = ? ORDER BY score DESC, created_at ASC').all(vacancyId) as Record<string, unknown>[];
  return rows.map((r) => mapResponse<A>(r));
}

/** Последний отклик кандидата на вакансию – чтобы не плодить дубли при повторном заходе. */
export function findResponseByCandidate<A = Record<string, unknown>>(db: Db, vacancyId: string, candidateUserId: number): ResponseRow<A> | null {
  const r = db.prepare('SELECT * FROM responses WHERE vacancy_id = ? AND candidate_user_id = ? ORDER BY created_at DESC LIMIT 1').get(vacancyId, candidateUserId) as Record<string, unknown> | undefined;
  return r ? mapResponse<A>(r) : null;
}

export function updateResponseStatus<A = Record<string, unknown>>(db: Db, id: string, status: ResponseStatus): ResponseRow<A> | null {
  const res = db.prepare('UPDATE responses SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
  return res.changes > 0 ? getResponse<A>(db, id) : null;
}

export class HiringStateError extends Error {}

/** Проверка и изменение отклика + закрытие вакансии проходят одной синхронной транзакцией, без сетевых ожиданий. */
export function transitionResponse<A>(db: Db, id: string, ownerId: number, target: 'invited' | 'rejected' | 'hired'): { response: ResponseRow<A>; vacancy: VacancyRow; changed: boolean } {
  db.exec('BEGIN IMMEDIATE');
  try {
    const response = getResponse<A>(db, id);
    const vacancy = response ? getVacancy(db, response.vacancyId) : null;
    if (!response || !vacancy || vacancy.maxUserId !== ownerId) throw new HiringStateError('Отклик не найден или принадлежит другому работодателю');
    if (response.status === target) { db.exec('COMMIT'); return { response, vacancy, changed: false }; }
    if (vacancy.status !== 'open') throw new HiringStateError('Вакансия уже закрыта: изменить решение нельзя');
    if (response.status === 'hired' || response.status === 'rejected') throw new HiringStateError('По этому отклику уже принято окончательное решение');
    const updated = updateResponseStatus<A>(db, id, target)!;
    const updatedVacancy = target === 'hired' ? closeVacancy(db, vacancy.id, ownerId, id) : vacancy;
    if (!updatedVacancy) throw new HiringStateError('Вакансия уже закрыта');
    db.exec('COMMIT');
    return { response: updated, vacancy: updatedVacancy, changed: true };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/* ---------- идемпотентность ---------- */

/** Коды SQLite нарушения уникальности: SQLITE_CONSTRAINT_PRIMARYKEY (1555) и SQLITE_CONSTRAINT_UNIQUE (2067). */
const UNIQUE_VIOLATION = new Set([1555, 2067]);

/** Нарушение первичного ключа или уникального индекса (а не «диск полон» или «база закрыта»). */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && UNIQUE_VIOLATION.has(code);
}

/**
 * true – событие новое, false – уже видели. Любая другая ошибка базы (SQLITE_FULL, SQLITE_IOERR)
 * пробрасывается: иначе бот молча терял бы все события под видом «дубликатов».
 */
export function markUpdateSeen(db: Db, updateKey: string): boolean {
  try {
    db.prepare('INSERT INTO updates_seen (update_key, received_at) VALUES (?, ?)').run(updateKey, nowIso());
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}
export function pruneUpdatesSeen(db: Db, olderThanIso: string): void {
  db.prepare('DELETE FROM updates_seen WHERE received_at < ?').run(olderThanIso);
}

/* ---------- очистка данных ---------- */

export interface CleanupOptions {
  now?: Date;
  /** Кэш выдачи «Работы России» старше стольких дней (по умолчанию 7). */
  vacancyCacheDays?: number;
  /** Анонимные карточки (демо-режим, прогрев кэша) старше стольких дней (по умолчанию 3). */
  anonymousCardDays?: number;
  /** Наблюдения за вакансиями, не появлявшимися в выдаче столько дней (по умолчанию 30). */
  vacancySeenDays?: number;
}

export interface CleanupReport { vacancyCache: number; anonymousCards: number; vacancySeen: number }

/**
 * Суточная чистка: строки кэша вакансий по мегабайту каждая, анонимные карточки и старые
 * наблюдения иначе копятся без предела. Карточки пользователей MAX не трогаем – на них
 * ссылаются отчёты, вакансии и ссылки «Подробный разбор».
 */
export function cleanupData(db: Db, opts: CleanupOptions = {}): CleanupReport {
  const now = (opts.now ?? new Date()).getTime();
  const before = (days: number) => new Date(now - days * 86400_000).toISOString();
  const vacancyCache = db.prepare('DELETE FROM vacancy_cache WHERE fetched_at < ?').run(before(opts.vacancyCacheDays ?? 7)).changes;
  const anonymousCards = db.prepare('DELETE FROM cards WHERE max_user_id IS NULL AND created_at < ?').run(before(opts.anonymousCardDays ?? 3)).changes;
  const vacancySeen = db.prepare('DELETE FROM vacancy_seen WHERE last_seen < ?').run(before(opts.vacancySeenDays ?? 30)).changes;
  return { vacancyCache: Number(vacancyCache), anonymousCards: Number(anonymousCards), vacancySeen: Number(vacancySeen) };
}

/** Сбрасывает WAL в основной файл и обрезает журнал: после массовых DELETE он иначе остаётся большим. */
export function checkpointWal(db: Db): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

/**
 * VACUUM возвращает освобождённые страницы файловой системе. Внутри транзакции он невозможен
 * (загрузка ЕРКНМ держит транзакцию между пачками), поэтому в этом случае возвращаем false – вызывающая сторона повторит позже.
 */
export function vacuumDb(db: Db): boolean {
  if ((db as { isTransaction?: boolean }).isTransaction) return false;
  db.exec('VACUUM');
  return true;
}

/* ---------- голосования ---------- */
export function castVote(db: Db, mid: string, maxUserId: number, optionKind: string): { counts: Record<string, number>; total: number } {
  db.prepare('INSERT INTO votes (mid, max_user_id, option_kind, voted_at) VALUES (?, ?, ?, ?) ON CONFLICT(mid, max_user_id) DO UPDATE SET option_kind = excluded.option_kind, voted_at = excluded.voted_at')
    .run(mid, maxUserId, optionKind, nowIso());
  const rows = db.prepare('SELECT option_kind, COUNT(*) AS n FROM votes WHERE mid = ? GROUP BY option_kind').all(mid) as { option_kind: string; n: number }[];
  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of rows) { counts[r.option_kind] = r.n; total += r.n; }
  return { counts, total };
}

/* ---------- плановые проверки (ЕРКНМ) ---------- */

export type InspectionKindKey = 'labor' | 'sanitary' | 'fire' | 'other';

export interface InspectionRow {
  id: string;
  year: number;
  erpId: string;
  inn: string | null;
  ogrn: string | null;
  subjectName: string | null;
  subjectType: string | null;
  mspCode: string | null;
  okved: string | null;
  okved2: string | null;
  kind: InspectionKindKey;
  kindControl: string | null;
  kindKnm: string | null;
  typeName: string | null;
  status: string | null;
  startDate: string | null;
  stopDate: string | null;
  organization: string | null;
  prosecutorOffice: string | null;
  address: string | null;
  regionCode: string | null;
  regionFnsCode: string | null;
}

export interface InspectionDatasetRow {
  year: number;
  datasetId: string;
  /** Дата версии набора из имени файла, «2026-09-23». */
  version: string;
  fileName: string;
  records: number;
  withRegion: number;
  /** Когда набор загружен или последний раз подтверждён как актуальный. */
  loadedAt: string;
}

function mapInspection(r: Record<string, unknown>): InspectionRow {
  return {
    id: r.id as string, year: r.dataset_year as number, erpId: r.erp_id as string,
    inn: r.inn as string | null, ogrn: r.ogrn as string | null, subjectName: r.subject_name as string | null,
    subjectType: r.subject_type as string | null, mspCode: r.msp_code as string | null,
    okved: r.okved as string | null, okved2: r.okved2 as string | null,
    kind: r.kind as InspectionKindKey, kindControl: r.kind_control as string | null, kindKnm: r.kind_knm as string | null,
    typeName: r.type_name as string | null, status: r.status as string | null,
    startDate: r.start_date as string | null, stopDate: r.stop_date as string | null,
    organization: r.organization as string | null, prosecutorOffice: r.prosecutor_office as string | null,
    address: r.address as string | null, regionCode: r.region_code as string | null, regionFnsCode: r.region_fns_code as string | null,
  };
}

const INSPECTION_COLUMNS = 'id, dataset_year, erp_id, inn, ogrn, subject_name, subject_type, msp_code, okved, okved2, kind, kind_control, kind_knm, type_name, status, start_date, stop_date, organization, prosecutor_office, address, region_code, region_fns_code';

const STAGING_SCHEMA = `CREATE TABLE IF NOT EXISTS inspections_staging (${INSPECTION_COLUMNS.split(', ').map((c) => (c === 'id' ? 'id TEXT PRIMARY KEY' : c === 'dataset_year' ? 'dataset_year INTEGER' : `${c} TEXT`)).join(', ')})`;

export interface InspectionsLoader {
  add(row: InspectionRow): void;
  /** Переносит подготовленные строки в рабочую таблицу и записывает версию набора. */
  commit(dataset: Omit<InspectionDatasetRow, 'records' | 'withRegion' | 'loadedAt'>): InspectionDatasetRow;
  abort(): void;
}

const inspectionLoads = new WeakSet<Db>();

/**
 * Потоковая загрузка набора: строки копятся в промежуточной таблице пачками, а в рабочую
 * переносятся одной короткой транзакцией. Так в памяти не лежит весь набор, а читатели
 * не видят половину загрузки и не ждут её (перезаливка идемпотентна: повтор даёт тот же результат).
 */
export function beginInspectionsLoad(db: Db, year: number, batchSize = 1000): InspectionsLoader {
  if (inspectionLoads.has(db)) throw new Error('Загрузка набора проверок уже выполняется');
  inspectionLoads.add(db);
  db.exec('DROP TABLE IF EXISTS inspections_staging');
  db.exec(STAGING_SCHEMA);
  const insert = db.prepare(`INSERT OR REPLACE INTO inspections_staging (${INSPECTION_COLUMNS}) VALUES (${'?, '.repeat(21)}?)`);
  let pending: InspectionRow[] = [];
  let records = 0;
  let withRegion = 0;
  let ended = false;
  const flush = () => {
    if (!pending.length) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of pending) insert.run(r.id, year, r.erpId, r.inn, r.ogrn, r.subjectName, r.subjectType, r.mspCode, r.okved, r.okved2,
        r.kind, r.kindControl, r.kindKnm, r.typeName, r.status, r.startDate, r.stopDate, r.organization, r.prosecutorOffice,
        r.address, r.regionCode, r.regionFnsCode);
      db.exec('COMMIT'); pending = [];
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const cleanup = () => { db.exec('DROP TABLE IF EXISTS inspections_staging'); inspectionLoads.delete(db); ended = true; };
  return {
    add(r) {
      if (ended) throw new Error('Загрузка набора уже завершена');
      pending.push(r);
      records += 1;
      if (r.regionCode) withRegion += 1;
      if (pending.length >= Math.max(1, Math.min(10000, batchSize))) flush();
    },
    commit(dataset) {
      if (ended || dataset.year !== year) throw new Error('Некорректный год или завершённая загрузка набора');
      flush();
      const loadedAt = nowIso();
      db.prepare('BEGIN').run();
      try {
        db.prepare('DELETE FROM inspections WHERE dataset_year = ?').run(dataset.year);
        db.prepare(`INSERT OR REPLACE INTO inspections (${INSPECTION_COLUMNS}) SELECT ${INSPECTION_COLUMNS} FROM inspections_staging`).run();
        db.prepare('INSERT OR REPLACE INTO inspection_datasets (year, dataset_id, version, file_name, records, with_region, loaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(dataset.year, dataset.datasetId, dataset.version, dataset.fileName, records, withRegion, loadedAt);
        db.prepare('COMMIT').run();
      } catch (e) {
        db.prepare('ROLLBACK').run();
        throw e;
      }
      // Промежуточную таблицу убираем: её страницы возвращаются в файл базы и переиспользуются следующей загрузкой.
      cleanup();
      return { ...dataset, records, withRegion, loadedAt };
    },
    abort() {
      if (ended) return;
      pending = [];
      cleanup();
    },
  };
}

/** Перезаливка готового массива записей – удобна в тестах и для небольших наборов. */
export function replaceInspections(db: Db, dataset: Omit<InspectionDatasetRow, 'records' | 'withRegion' | 'loadedAt'>, rows: readonly InspectionRow[]): InspectionDatasetRow {
  const loader = beginInspectionsLoad(db, dataset.year);
  try {
    for (const r of rows) loader.add(r);
    return loader.commit(dataset);
  } catch (e) {
    loader.abort();
    throw e;
  }
}

export function getInspectionDataset(db: Db, year: number): InspectionDatasetRow | null {
  const r = db.prepare('SELECT * FROM inspection_datasets WHERE year = ?').get(year) as Record<string, unknown> | undefined;
  if (!r) return null;
  return { year: r.year as number, datasetId: r.dataset_id as string, version: r.version as string, fileName: r.file_name as string, records: r.records as number, withRegion: r.with_region as number, loadedAt: r.loaded_at as string };
}

/** Набор проверен и оказался актуальным: сдвигаем отметку, чтобы не ходить к источнику каждый час. */
export function touchInspectionDataset(db: Db, year: number, at: string = nowIso()): void {
  db.prepare('UPDATE inspection_datasets SET loaded_at = ? WHERE year = ?').run(at, year);
}

/** Плановые КНМ по ИНН субъекта: ближайшие сверху. */
export function inspectionsByInn(db: Db, inn: string, year: number, limit = 20): InspectionRow[] {
  const rows = db.prepare('SELECT * FROM inspections WHERE inn = ? AND dataset_year = ? ORDER BY COALESCE(start_date, \'9999\') ASC LIMIT ?').all(inn, year, limit) as Record<string, unknown>[];
  return rows.map(mapInspection);
}

/** Счётчики КНМ по видам надзора для контекста: регион и (при наличии) раздел ОКВЭД. */
export function inspectionCounts(db: Db, year: number, filter: { regionCode?: string | null; okved2?: string | null }): { byKind: Record<InspectionKindKey, number>; total: number } {
  const where = ['dataset_year = ?'];
  const args: (string | number)[] = [year];
  if (filter.regionCode) { where.push('region_code = ?'); args.push(filter.regionCode); }
  if (filter.okved2) { where.push('okved2 = ?'); args.push(filter.okved2); }
  const rows = db.prepare(`SELECT kind, COUNT(*) AS n FROM inspections WHERE ${where.join(' AND ')} GROUP BY kind`).all(...args) as { kind: string; n: number }[];
  const byKind: Record<InspectionKindKey, number> = { labor: 0, sanitary: 0, fire: 0, other: 0 };
  let total = 0;
  for (const r of rows) {
    if (r.kind === 'labor' || r.kind === 'sanitary' || r.kind === 'fire' || r.kind === 'other') byKind[r.kind] = r.n;
    total += r.n;
  }
  return { byKind, total };
}

export function getMeta(db: Db, key: string): string | null {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}
