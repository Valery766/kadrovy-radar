/**
 * Суточная чистка: данные, которые копятся без предела (кэш выдачи по мегабайту на строку,
 * анонимные карточки демо-режима, наблюдения за давно исчезнувшими вакансиями), файлы отчётов
 * и QR-кодов в DATA_DIR, затем сброс WAL и — раз в неделю — VACUUM основной базы.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.js';
import { checkpointWal, cleanupData, vacuumDb, type CleanupOptions, type CleanupReport } from '../db/index.js';

/** Файлы отчётов и QR-кодов старше стольких дней удаляются: отчёт уже отправлен в MAX (в базе остаётся mid), QR загружен в чат при публикации. */
export const FILE_MAX_AGE_DAYS = 14;

export interface HousekeepingInput {
  db: Db;
  dataDir: string;
  /** Делать ли VACUUM в этот раз (планировщик — раз в неделю). */
  vacuum?: boolean;
  now?: Date;
  data?: CleanupOptions;
  fileMaxAgeDays?: number;
}

export interface HousekeepingReport {
  /** true — база в открытой транзакции (идёт загрузка ЕРКНМ): ничего не трогали, повторить позже. */
  skipped: boolean;
  data: CleanupReport;
  /** Сколько файлов удалено в reports/ и qr/. */
  files: number;
  vacuumed: boolean;
}

/** Удаляет обычные файлы каталога старше maxAgeMs по времени изменения; каталога нет — 0. */
export function pruneFiles(dir: string, maxAgeMs: number, now = Date.now()): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue;
      unlinkSync(path);
      removed += 1;
    } catch { /* файл уже удалён или недоступен — пропускаем */ }
  }
  return removed;
}

export function runHousekeeping(input: HousekeepingInput): HousekeepingReport {
  const empty: CleanupReport = { vacancyCache: 0, anonymousCards: 0, vacancySeen: 0 };
  if ((input.db as { isTransaction?: boolean }).isTransaction) return { skipped: true, data: empty, files: 0, vacuumed: false };
  const now = input.now ?? new Date();
  const data = cleanupData(input.db, { ...input.data, now });
  const maxAgeMs = (input.fileMaxAgeDays ?? FILE_MAX_AGE_DAYS) * 86400_000;
  const files = pruneFiles(join(input.dataDir, 'reports'), maxAgeMs, now.getTime()) + pruneFiles(join(input.dataDir, 'qr'), maxAgeMs, now.getTime());
  checkpointWal(input.db);
  const vacuumed = input.vacuum ? vacuumDb(input.db) : false;
  return { skipped: false, data, files, vacuumed };
}
