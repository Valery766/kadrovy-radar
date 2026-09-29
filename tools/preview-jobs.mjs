/** Изолированный UI-стенд с синтетическими ролями. Никогда не импортируется production entrypoint. */
import { readFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { buildApp, MINIAPP_CSP } from '../server/dist/app.js';
import { loadConfig } from '../server/dist/config.js';
import { buildSignedInitData } from '../server/dist/api/auth.js';
import { putBusinessProfile, putCard, putResponse, putVacancy, putVacancyCache, upsertUser, upsertSubscription } from '../server/dist/db/index.js';
import { computeMarket } from '../server/dist/core/index.js';

// DAST must never forward mutated inputs to government APIs or MAX. Local REST validation and SQLite still run.
if (process.env.PREVIEW_SCAN_MODE === '1') globalThis.fetch = async () => { throw new Error('Outbound requests disabled on isolated scan target'); };

const dataDir = mkdtempSync(join(tmpdir(), 'max-jobs-preview-'));
const token = 'synthetic-preview-bot-token-not-a-real-max-key';
const config = loadConfig({ MAX_UPDATES_MODE: 'none', MAX_BOT_TOKEN: token, SESSION_SECRET: 'synthetic-preview-session-secret-32-chars', PACKS_DIR: resolve('packs'), DATA_DIR: dataDir, HOST: '127.0.0.1' });
const parts = await buildApp({ config, dbPath: ':memory:', bot: { username: 'synthetic_preview_bot', userId: 1 }, logger: false });
const { app, db } = parts;
const messages = [];
const recordMessage = async (uid, text) => { messages.push({ uid, text }); return { body: { mid: `preview-${messages.length}` } }; };
const fakeBot = { api: {
  sendMessageToUser: recordMessage,
  sendMessageToChat: recordMessage,
  uploadFile: async () => ({ toJson: () => ({ type: 'file', payload: { token: 'synthetic-file' } }) }),
  uploadImage: async () => ({ toJson: () => ({ type: 'image', payload: { token: 'synthetic-image' } }) }),
} };
parts.apiDeps.hiring = { db, config, bot: fakeBot, botUsername: 'synthetic_preview_bot' };
for (const [uid, name] of [[90001, 'ТЕСТ · Работодатель'], [90002, 'ТЕСТ · Кандидат']]) upsertUser(db, { maxUserId: uid, name });
for (const [id, title, salary, region] of [['preview-cook', 'ТЕСТ · Повар', 65000, '7800000000000'], ['preview-driver', 'ТЕСТ · Водитель', 80000, '1600000000000']]) {
  putVacancy(db, { id, maxUserId: process.env.PREVIEW_SCAN_MODE === '1' && id === 'preview-driver' ? 90002 : 90001, cardId: null, professionKey: id, regionCode: region, title, salary,
    text: `${title}\nСинтетическое объявление для проверки интерфейса. Это не реальная вакансия.\nГрафик 2/2, оформление и обязанности обсуждаются на тестовом собеседовании.`, employerName: 'ТЕСТ · Учебное кафе', listed: true });
}
if (process.env.PREVIEW_SCAN_MODE === '1') {
  // Independent lifecycle fixtures: a hire/reject/close probe must not close another operation's vacancy.
  for (const purpose of ['hire', 'invite', 'reject', 'listing', 'close']) {
    const id = `preview-${purpose}`;
    putVacancy(db, { id, maxUserId: 90001, cardId: null, professionKey: 'povar', regionCode: '7800000000000', title: `ТЕСТ · ${purpose}`, salary: 65000, text: 'Синтетический объект для DAST, не реальная вакансия.', employerName: 'ТЕСТ', listed: false });
    if (['hire', 'invite', 'reject'].includes(purpose)) putResponse(db, { id, vacancyId: id, candidateUserId: 90002, candidateName: 'ТЕСТ', answers: { experience: 'mid', schedule: true, expectedSalary: null }, phone: null, phoneVerified: false, score: 10 });
  }
  parts.apiDeps.report = { db, config, bot: fakeBot, botUsername: 'synthetic_preview_bot' };
  putResponse(db, { id: 'preview-response', vacancyId: 'preview-cook', candidateUserId: 90002, candidateName: 'ТЕСТ · Кандидат', answers: { experience: 'mid', schedule: true, expectedSalary: null }, phone: null, phoneVerified: false, score: 10 });
  const createdAt = new Date().toISOString();
  const pack = parts.catalog.packs.find((p) => p.id === 'generic');
  const profession = parts.catalog.professions.find((p) => p.key === 'povar');
  const vacancies = Array.from({ length: 40 }, (_, i) => ({ id: `synthetic-market-${i}`, title: 'Повар', salaryMin: 50000 + i * 1000, salaryMax: 50000 + i * 1000, employerInn: null, employerOgrn: null, employerName: `ТЕСТ · Организация ${i}`, typicalPosition: null, codeProfession: null, regionCode: '7800000000000', schedule: 'Сменный график', employment: 'Полная занятость', requirement: 'ТЕСТ', duty: 'ТЕСТ', experienceYears: 1, education: null, workPlaces: 1, hrAgency: false, url: null, createdAt, modifiedAt: createdAt, lat: null, lng: null, employer: null }));
  for (const regionCode of ['7800000000000', '1600000000000']) putVacancyCache(db, { cacheKey: `${regionCode}:${profession.query.toLowerCase()}`, regionCode, query: profession.query, total: vacancies.length, payload: vacancies.map((v) => ({ ...v, regionCode })), fetchedAt: createdAt });
  const card = computeMarket({ vacancies, profession, regionCode: '7800000000000', regionName: 'Санкт-Петербург', offer: 65000, thresholds: pack.thresholds, requirementPhrases: pack.requirementPhrases, userCategory: null });
  const region = parts.catalog.regions.find((r) => r.fnsCode === '78');
  const payload = { cardId: 'preview-card', card, profession, region, profile: null, pack, fetched: { fetchedAt: createdAt, total: 40, records: 40 }, sources: [], closure: null, createdAt };
  putBusinessProfile(db, '7800000002', { inn: '7800000002', name: 'ТЕСТ · Не реальная организация', category: 1, okved: '56.10', okvedName: 'ТЕСТ', fnsRegionCode: '78', kind: 'UL', registeredAt: null, active: true, found: true }, createdAt);
  putCard(db, { id: 'preview-card', maxUserId: 90001, inn: null, packId: 'generic', professionKey: 'povar', regionCode: '7800000000000', offer: null, payload });
  upsertSubscription(db, { id: 'preview-subscription', maxUserId: 90001, chatId: 90001, packId: 'generic', professionKey: 'povar', regionCode: '7800000000000', offer: null, lastMedian: 65000 });
}
const html = readFileSync(resolve('webapp/dist/index.html'), 'utf8').replace(/<script src="https:\/\/st\.max\.ru\/js\/max-web-app\.js"><\/script>/, '');
for (const [role, uid, start] of [['candidate', 90002, 'jobs'], ['employer', 90001, 'inbox'], ['market', 90001, 'card_preview-card'], ['home', 90001, '']]) {
  app.get(`/preview/${role}`, (_req, reply) => {
    const initData = buildSignedInitData(token, { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: uid, first_name: `ТЕСТ · ${role}` }), start_param: start });
    const bridge = { initData, initDataUnsafe: { start_param: start }, platform: 'web', colorScheme: 'light' };
    const nonce = randomBytes(18).toString('base64');
    // Test bridge uses a fresh per-response nonce, never unsafe-inline or a production policy bypass.
    const csp = MINIAPP_CSP.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`);
    return reply.type('text/html').header('cache-control', 'no-store').header('content-security-policy', csp).send(html.replace('<head>', `<head><script nonce="${nonce}">window.WebApp=${JSON.stringify(bridge)};</script>`).replace('<body>', `<body><aside><mark>ЛОКАЛЬНЫЙ ТЕСТ · ${role} · данные синтетические, сообщения в MAX не отправляются</mark></aside>`));
  });
}
app.get('/preview/messages', () => ({ messages }));
const port = Number(process.env.PREVIEW_PORT ?? 8093);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PREVIEW_PORT');
await app.listen({ host: '127.0.0.1', port });
console.log(`Isolated preview: http://127.0.0.1:${port}/preview/candidate and /preview/employer`);
const stop = async () => { await app.close(); db.close(); process.exit(0); };
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
