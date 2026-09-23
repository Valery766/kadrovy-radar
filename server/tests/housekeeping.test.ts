/**
 * Суточная чистка данных и файлов и идемпотентность вебхука: что удаляется, что остаётся
 * и как отличается «уже видели» от настоящей ошибки базы.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isUniqueViolation, markUpdateSeen, openDb, putCard, putVacancyCache, recordVacancySeen, type Db,
} from '../src/db/index.js';
import { pruneFiles, runHousekeeping } from '../src/services/housekeeping.js';

const daysAgo = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();

describe('идемпотентность: markUpdateSeen', () => {
  const db = openDb(':memory:');

  it('считает повтор ключа дубликатом, а не ошибкой', () => {
    expect(markUpdateSeen(db, 'message_callback:1:cb1')).toBe(true);
    expect(markUpdateSeen(db, 'message_callback:1:cb1')).toBe(false);
  });

  it('пробрасывает ошибку базы, не связанную с уникальностью', () => {
    // SQLITE_FULL (13): иначе бот молча терял бы события под видом «дубликатов».
    const broken = {
      prepare: () => ({
        run: () => { throw Object.assign(new Error('database or disk is full'), { errcode: 13, errstr: 'SQLITE_FULL' }); },
      }),
    } as unknown as Db;
    expect(() => markUpdateSeen(broken, 'message_created:1:mid.1')).toThrowError(/disk is full/);
  });

  it('узнаёт нарушение первичного ключа и уникального индекса', () => {
    expect(isUniqueViolation({ errcode: 1555 })).toBe(true); // SQLITE_CONSTRAINT_PRIMARYKEY
    expect(isUniqueViolation({ errcode: 2067 })).toBe(true); // SQLITE_CONSTRAINT_UNIQUE
    expect(isUniqueViolation({ errcode: 13 })).toBe(false);  // SQLITE_FULL
    expect(isUniqueViolation({ errcode: '1555' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe('суточная чистка', () => {
  let dir: string;
  let db: Db;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'stavka-housekeeping-'));
    db = openDb(join(dir, 'stavka.db'));

    putVacancyCache(db, { cacheKey: 'old', regionCode: '78', query: 'повар', total: 1, payload: [{ id: 'v-old' }], fetchedAt: daysAgo(10) });
    putVacancyCache(db, { cacheKey: 'fresh', regionCode: '78', query: 'повар', total: 1, payload: [{ id: 'v-fresh' }], fetchedAt: daysAgo(1) });

    const card = (id: string, maxUserId: number | null, createdDaysAgo: number) => {
      putCard(db, { id, maxUserId, inn: null, packId: 'generic', professionKey: 'povar', regionCode: '78', offer: null, payload: {} });
      db.prepare('UPDATE cards SET created_at = ? WHERE id = ?').run(daysAgo(createdDaysAgo), id);
    };
    card('anon-old', null, 5);
    card('anon-fresh', null, 1);
    card('user-old', 1, 100); // карточка пользователя MAX: на неё ссылаются отчёты и вакансии — не трогаем

    recordVacancySeen(db, '78', 'povar', [{ id: 'seen-old', employerInn: null, value: 50000 }], daysAgo(60));
    recordVacancySeen(db, '78', 'povar', [{ id: 'seen-fresh', employerInn: null, value: 60000 }], daysAgo(2));

    for (const sub of ['reports', 'qr']) {
      mkdirSync(join(dir, sub), { recursive: true });
      const old = join(dir, sub, `${sub}-old.bin`);
      writeFileSync(old, 'x');
      const t = (Date.now() - 20 * 86400_000) / 1000;
      utimesSync(old, t, t);
      writeFileSync(join(dir, sub, `${sub}-fresh.bin`), 'x');
    }
  });

  afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  const ids = (table: string, column: string) => (db.prepare(`SELECT ${column} AS id FROM ${table} ORDER BY id`).all() as { id: string }[]).map((r) => r.id);

  it('удаляет только просроченное: старый кэш, анонимные карточки и забытые наблюдения', () => {
    const r = runHousekeeping({ db, dataDir: dir });
    expect(r.skipped).toBe(false);
    expect(r.data).toEqual({ vacancyCache: 1, anonymousCards: 1, vacancySeen: 1 });
    expect(r.vacuumed).toBe(false);
    expect(ids('vacancy_cache', 'cache_key')).toEqual(['fresh']);
    expect(ids('cards', 'id')).toEqual(['anon-fresh', 'user-old']);
    expect(ids('vacancy_seen', 'vacancy_id')).toEqual(['seen-fresh']);
    // Файлы отчётов и QR старше 14 дней — по одному в каждом каталоге.
    expect(r.files).toBe(2);
    expect(readdirSync(join(dir, 'reports'))).toEqual(['reports-fresh.bin']);
    expect(readdirSync(join(dir, 'qr'))).toEqual(['qr-fresh.bin']);
  });

  it('повторный прогон ничего не удаляет и делает VACUUM по запросу', () => {
    const r = runHousekeeping({ db, dataDir: dir, vacuum: true });
    expect(r.data).toEqual({ vacancyCache: 0, anonymousCards: 0, vacancySeen: 0 });
    expect(r.files).toBe(0);
    expect(r.vacuumed).toBe(true);
  });

  it('пропускает прогон, пока база в открытой транзакции', () => {
    db.exec('BEGIN');
    try {
      const r = runHousekeeping({ db, dataDir: dir, vacuum: true });
      expect(r).toEqual({ skipped: true, data: { vacancyCache: 0, anonymousCards: 0, vacancySeen: 0 }, files: 0, vacuumed: false });
    } finally {
      db.exec('ROLLBACK');
    }
    // После закрытия транзакции задача снова работает.
    expect(runHousekeeping({ db, dataDir: dir }).skipped).toBe(false);
  });
});

describe('pruneFiles', () => {
  it('удаляет только старые файлы и не спотыкается об отсутствующий каталог', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stavka-prune-'));
    try {
      const old = join(dir, 'old.pdf');
      writeFileSync(old, 'x');
      const t = (Date.now() - 30 * 86400_000) / 1000;
      utimesSync(old, t, t);
      writeFileSync(join(dir, 'fresh.pdf'), 'x');
      mkdirSync(join(dir, 'nested'));

      expect(pruneFiles(dir, 14 * 86400_000)).toBe(1);
      expect(readdirSync(dir).sort()).toEqual(['fresh.pdf', 'nested']);
      expect(pruneFiles(dir, 14 * 86400_000)).toBe(0);
      expect(pruneFiles(join(dir, 'нет-такого'), 14 * 86400_000)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
