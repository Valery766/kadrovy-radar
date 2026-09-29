#!/usr/bin/env node
/**
 * Заливает учебный каталог вакансий (tools/demo-catalog.json) в базу решения.
 *
 * Данные вымышленные и явно помечены: набор нужен, чтобы жюри видело живой каталог с поиском,
 * фильтрами и страницами, а не пустой экран. Инструмент повторяемый: идентификаторы вакансий
 * выводятся из ключа партии, поэтому повторный запуск обновляет те же строки и не создаёт дублей.
 *
 *   node tools/seed-demo-catalog.mjs --db <путь> [--owner auto|<maxUserId>] [--with-responses] [--backup-dir <путь>]
 *   node tools/seed-demo-catalog.mjs --db <путь> --apply        # без --apply только показывает план
 *   node tools/seed-demo-catalog.mjs --db <путь> --remove --apply  # откат: удалить строки партии
 *
 * Перед записью инструмент делает резервную копию базы (VACUUM INTO) и печатает путь.
 * Вакансии пишутся только по идентификаторам своей партии. Единственное исключение -
 * флаг --unlist-legacy: он снимает с показа прежние объявления указанного владельца,
 * поэтому требует явного --owner и записывает снятые идентификаторы в файл рядом
 * с резервной копией, чтобы --remove вернул их в каталог.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const dbPath = value('db');
if (!dbPath) {
  console.error('Укажите базу: --db /srv/max-radar/data/stavka.db');
  process.exit(2);
}
const apply = flag('apply');
const remove = flag('remove');
const withResponses = flag('with-responses');
const datasetPath = resolve(value('dataset', join(import.meta.dirname, 'demo-catalog.json')));
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
const batch = dataset.batch;
if (!/^[a-zA-Z0-9._-]{1,64}$/.test(batch ?? '')) {
  console.error(`Ключ партии «${batch}» недопустим: разрешены буквы, цифры, точка, дефис и подчёркивание, не длиннее 64 символов.`);
  process.exit(2);
}
const idOf = (key) => createHash('sha256').update(`${batch}:${key}`).digest('hex').slice(0, 32);

const db = new DatabaseSync(resolve(dbPath));
db.exec('PRAGMA busy_timeout = 15000');
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);

const ids = dataset.vacancies.map((v) => idOf(v.key));
const placeholders = ids.map(() => '?').join(',');
const before = {
  vacancies: one('SELECT COUNT(*) AS n FROM vacancies').n,
  catalog: one("SELECT COUNT(*) AS n FROM vacancies WHERE listed = 1 AND status = 'open'").n,
  responses: one('SELECT COUNT(*) AS n FROM responses').n,
  users: one('SELECT COUNT(*) AS n FROM users').n,
  mine: one(`SELECT COUNT(*) AS n FROM vacancies WHERE id IN (${placeholders})`, ...ids).n,
};

/** Владелец учебных вакансий: явно заданный id или тот, кто уже публиковал в этой базе. */
const ownerArg = value('owner', 'auto');
const unlistLegacy = flag('unlist-legacy');
let owner = Number(ownerArg);
if (ownerArg === 'auto') {
  // Автовыбор годится только для наполнения: он берёт последнего публиковавшего, а это может быть
  // посторонний пользователь. Снимать чужие объявления с показа по догадке недопустимо.
  if (unlistLegacy) {
    console.error('--unlist-legacy требует явного --owner <maxUserId>: снимать с показа объявления угаданного владельца нельзя.');
    process.exit(2);
  }
  const row = one(`SELECT max_user_id AS uid FROM vacancies WHERE id NOT IN (${placeholders}) AND max_user_id > 0 ORDER BY created_at DESC LIMIT 1`, ...ids);
  owner = row?.uid ?? null;
}
if (!Number.isInteger(owner) || owner <= 0) {
  console.error('Не удалось определить владельца вакансий. Передайте --owner <maxUserId> (положительный id аккаунта MAX).');
  process.exit(2);
}

console.log(`База: ${resolve(dbPath)}`);
console.log(`Партия: ${batch}, записей в наборе: ${dataset.vacancies.length}`);
console.log(`Владелец учебных вакансий: ${owner}`);
console.log(`До: всего вакансий ${before.vacancies}, в каталоге ${before.catalog}, откликов ${before.responses}, своих строк партии ${before.mine}`);

if (!apply) {
  console.log('\nРежим проверки. Ничего не записано. Добавьте --apply, чтобы применить.');
  db.close();
  process.exit(0);
}

/** Резервная копия рядом с базой: без неё откат к состоянию «до» невозможен. */
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const backupDir = resolve(value('backup-dir', dirname(resolve(dbPath))));
const backup = join(backupDir, `stavka-before-${batch}-${stamp}.db`);
const unlistedLog = join(backupDir, `unlisted-${batch}.json`);
if (existsSync(backup)) { console.error(`Резервная копия уже существует: ${backup}`); process.exit(2); }
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
const check = new DatabaseSync(backup, { readOnly: true });
const integrity = check.prepare('PRAGMA integrity_check').get();
check.close();
chmodSync(backup, 0o600); // в копии есть персональные данные пользователей и откликов
console.log(`Резервная копия: ${backup} (${(statSync(backup).size / 1e6).toFixed(1)} МБ, integrity_check: ${Object.values(integrity)[0]})`);
console.log('В резервной копии есть персональные данные: держите её на сервере и удалите, когда она больше не нужна.');

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const CANDIDATE_BASE = -9_000_000; // вне диапазона демо-сессий (-2 000 000…-1 000 000) и реальных id MAX (> 0)

db.exec('BEGIN IMMEDIATE');
try {
  if (remove) {
    // Отклики настоящих людей на учебные вакансии не наши: удаляем только синтетические
    // (их идентификаторы пользователей заведомо ниже CANDIDATE_BASE) и предупреждаем об остальных.
    const foreign = one(`SELECT COUNT(*) AS n FROM responses WHERE vacancy_id IN (${placeholders}) AND candidate_user_id > ?`, ...ids, CANDIDATE_BASE).n;
    const del = db.prepare(`DELETE FROM responses WHERE vacancy_id IN (${placeholders}) AND candidate_user_id <= ?`).run(...ids, CANDIDATE_BASE);
    const delV = db.prepare(`DELETE FROM vacancies WHERE id IN (${placeholders}) AND id NOT IN (SELECT vacancy_id FROM responses)`).run(...ids);
    console.log(`Удалено: вакансий ${delV.changes}, учебных откликов ${del.changes}`);
    if (foreign) console.log(`Оставлено вакансий с настоящими откликами: ${foreign} откликов не наши, эти вакансии не удалены`);
    if (existsSync(unlistedLog)) {
      const back = JSON.parse(readFileSync(unlistedLog, 'utf8'));
      const restore = db.prepare('UPDATE vacancies SET listed = 1 WHERE id = ?');
      let n = 0;
      for (const id of back.ids ?? []) n += restore.run(id).changes;
      console.log(`Возвращено в каталог прежних объявлений: ${n} (список ${unlistedLog})`);
    }
  } else {
    const upsert = db.prepare(`INSERT INTO vacancies (id, max_user_id, card_id, profession_key, region_code, title, salary, text, employer_name, status, listed, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'open', 1, ?)
      ON CONFLICT(id) DO UPDATE SET max_user_id = excluded.max_user_id, profession_key = excluded.profession_key,
        region_code = excluded.region_code, title = excluded.title, salary = excluded.salary, text = excluded.text,
        employer_name = excluded.employer_name, listed = excluded.listed, created_at = excluded.created_at`);
    for (const v of dataset.vacancies) {
      const createdAt = iso(now - v.ageDays * 86_400_000 - v.minutes * 60_000);
      upsert.run(idOf(v.key), owner, v.professionKey, v.regionCode, v.title, v.salary, v.text, v.employerName, createdAt);
    }
    console.log(`Записано вакансий: ${dataset.vacancies.length}`);

    // Прежние учебные публикации того же владельца убираем из каталога, но не удаляем:
    // ссылки и QR продолжают работать, а каталог показывает один актуальный набор.
    if (unlistLegacy) {
      const legacy = all(`SELECT id, title FROM vacancies WHERE max_user_id = ? AND listed = 1 AND id NOT IN (${placeholders})`, owner, ...ids);
      db.prepare(`UPDATE vacancies SET listed = 0 WHERE max_user_id = ? AND listed = 1 AND id NOT IN (${placeholders})`).run(owner, ...ids);
      writeFileSync(unlistedLog, JSON.stringify({ batch, owner, at: iso(now), ids: legacy.map((r) => r.id), titles: legacy.map((r) => r.title) }, null, 1), { mode: 0o600 });
      console.log(`Снято с показа прежних объявлений: ${legacy.length}${legacy.length ? ` (${legacy.slice(0, 5).map((r) => r.title).join(', ')}${legacy.length > 5 ? ', …' : ''})` : ''}`);
      console.log(`Список для возврата: ${unlistedLog}`);
    }

    if (withResponses) {
      db.prepare(`DELETE FROM responses WHERE vacancy_id IN (${placeholders})`).run(...ids);
      const putResponse = db.prepare(`INSERT INTO responses (id, vacancy_id, candidate_user_id, candidate_name, answers, phone, phone_verified, score, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)`);
      const touch = db.prepare('UPDATE vacancies SET first_response_at = ?, status = ?, closed_at = ?, hired_response_id = ?, listed = ? WHERE id = ?');
      const plan = dataset.responses ?? [];
      for (const r of plan) {
        const vacancyId = idOf(r.vacancyKey);
        let first = null;
        let hiredId = null;
        r.candidates.forEach((c, i) => {
          const createdAt = iso(now - c.ageHours * 3_600_000);
          const id = idOf(`${r.vacancyKey}:response:${i}`);
          putResponse.run(id, vacancyId, CANDIDATE_BASE - Math.abs(hashInt(`${r.vacancyKey}:${i}`)), c.name,
            JSON.stringify(c.answers), c.score, c.status, createdAt, createdAt);
          if (!first || createdAt < first) first = createdAt;
          if (c.status === 'hired') hiredId = id;
        });
        const closed = Boolean(hiredId);
        touch.run(first, closed ? 'closed' : 'open', closed ? iso(now - r.closedHoursAgo * 3_600_000) : null, hiredId, closed ? 0 : 1, vacancyId);
      }
      console.log(`Записано откликов: ${plan.reduce((n, r) => n + r.candidates.length, 0)} на ${plan.length} вакансиях`);
    }
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('Ошибка, изменения отменены:', err);
  process.exit(1);
}

const after = {
  vacancies: one('SELECT COUNT(*) AS n FROM vacancies').n,
  catalog: one("SELECT COUNT(*) AS n FROM vacancies WHERE listed = 1 AND status = 'open'").n,
  responses: one('SELECT COUNT(*) AS n FROM responses').n,
  users: one('SELECT COUNT(*) AS n FROM users').n,
};
const regions = all(`SELECT region_code, COUNT(*) AS n FROM vacancies WHERE listed = 1 AND status = 'open' GROUP BY 1`).length;
console.log(`После: всего вакансий ${after.vacancies}, в каталоге ${after.catalog} в ${regions} регионах, откликов ${after.responses}`);
if (after.users !== before.users) console.error(`ВНИМАНИЕ: число пользователей изменилось (${before.users} → ${after.users})`);
console.log(`Проверка целостности: ${Object.values(db.prepare('PRAGMA integrity_check').get())[0]}`);
console.log(`Откат: node tools/seed-demo-catalog.mjs --db ${resolve(dbPath)} --remove --apply (или восстановить ${backup})`);
db.close();

function hashInt(s) {
  return Number.parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) % 1_000_000;
}
