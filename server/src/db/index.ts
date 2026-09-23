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

-- Кэш выдачи «Работы России»: ключ = регион + запрос; payload — массив VacancyRecord (JSON).
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

-- Идемпотентность вебхука: MAX может доставить одно событие до 10 раз.
CREATE TABLE IF NOT EXISTS updates_seen (
  update_key TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
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
    .run(patch.inn ?? cur.inn, patch.regionFnsCode ?? cur.regionFnsCode, patch.packId ?? cur.packId, JSON.stringify(patch.state ?? cur.state), patch.chatId ?? cur.chatId, nowIso(), maxUserId);
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
  return (db.prepare('SELECT * FROM subscriptions WHERE active = 1 AND max_user_id = ?').all(maxUserId) as Record<string, unknown>[]).map(mapSub);
}
export function deactivateSubscription(db: Db, id: string, maxUserId: number): boolean {
  const r = db.prepare('UPDATE subscriptions SET active = 0 WHERE id = ? AND max_user_id = ?').run(id, maxUserId);
  return r.changes > 0;
}
export function touchSubscription(db: Db, id: string, lastMedian: number | null): void {
  db.prepare('UPDATE subscriptions SET last_median = ?, last_checked_at = ? WHERE id = ?').run(lastMedian, nowIso(), id);
}

/* ---------- идемпотентность ---------- */
export function markUpdateSeen(db: Db, updateKey: string): boolean {
  try {
    db.prepare('INSERT INTO updates_seen (update_key, received_at) VALUES (?, ?)').run(updateKey, nowIso());
    return true;
  } catch {
    return false;
  }
}
export function pruneUpdatesSeen(db: Db, olderThanIso: string): void {
  db.prepare('DELETE FROM updates_seen WHERE received_at < ?').run(olderThanIso);
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

export function getMeta(db: Db, key: string): string | null {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}
