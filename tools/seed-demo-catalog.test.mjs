import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

test('repeat seeding preserves real responses and hiring state without duplicating synthetic responses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'max-seed-regression-'));
  const dbPath = join(dir, 'fixture.db');
  const datasetPath = join(dir, 'dataset.json');
  const batch = 'seed-regression';
  const idOf = (key) => createHash('sha256').update(`${batch}:${key}`).digest('hex').slice(0, 32);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE vacancies (
      id TEXT PRIMARY KEY, max_user_id INTEGER, card_id TEXT, profession_key TEXT,
      region_code TEXT, title TEXT, salary INTEGER, text TEXT, employer_name TEXT,
      status TEXT, listed INTEGER, created_at TEXT, first_response_at TEXT,
      closed_at TEXT, hired_response_id TEXT
    );
    CREATE TABLE responses (
      id TEXT PRIMARY KEY, vacancy_id TEXT, candidate_user_id INTEGER,
      candidate_name TEXT, answers TEXT, phone TEXT, phone_verified INTEGER,
      score INTEGER, status TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(vacancy_id, candidate_user_id)
    );
  `);
  const vacancy = (key) => ({ key, professionKey: 'povar', regionCode: '7800000000000', title: 'Учебная вакансия', salary: 60000, text: 'Учебное объявление', employerName: 'Учебный работодатель', ageDays: 0, minutes: 0 });
  const candidate = { name: 'Учебный кандидат', answers: { experience: 'mid', schedule: true, expectedSalary: null }, score: 10, status: 'new', ageHours: 1 };
  writeFileSync(datasetPath, JSON.stringify({ batch, vacancies: [vacancy('with-real'), vacancy('synthetic-only')], responses: ['with-real', 'synthetic-only'].map((vacancyKey) => ({ vacancyKey, candidates: [candidate] })) }));
  const seed = () => {
    // Distinct backup directories keep the repeat check deterministic within one second.
    const backupDir = mkdtempSync(join(dir, 'backup-'));
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'seed-demo-catalog.mjs'), '--db', dbPath, '--dataset', datasetPath, '--owner', '42', '--with-responses', '--backup-dir', backupDir, '--apply'], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };
  seed();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM responses').get().n, 2);
  const realVacancy = idOf('with-real');
  const createdAt = '2026-09-20T10:00:00.000Z';
  db.prepare('INSERT INTO responses VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('real-response', realVacancy, 123456, 'Реальный кандидат', '{"schedule":true}', '+70000000000', 1, 11, 'hired', createdAt, createdAt);
  db.prepare("UPDATE vacancies SET title = 'Изменено владельцем', status = 'closed', listed = 0, first_response_at = ?, closed_at = ?, hired_response_id = 'real-response' WHERE id = ?").run(createdAt, createdAt, realVacancy);
  const beforeResponse = { ...db.prepare("SELECT * FROM responses WHERE id = 'real-response'").get() };
  const beforeVacancy = { ...db.prepare('SELECT * FROM vacancies WHERE id = ?').get(realVacancy) };
  seed();
  seed();
  assert.deepEqual({ ...db.prepare("SELECT * FROM responses WHERE id = 'real-response'").get() }, beforeResponse);
  assert.deepEqual({ ...db.prepare('SELECT * FROM vacancies WHERE id = ?').get(realVacancy) }, beforeVacancy);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM responses').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM responses WHERE candidate_user_id <= -9000000').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vacancies').get().n, 2);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
});
