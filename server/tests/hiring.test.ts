import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import type { Bot } from '@maxhub/max-bot-api';
import { buildApp, type AppParts } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { buildSignedInitData } from '../src/api/auth.js';
import {
  closeVacancy, findResponseByCandidate, getVacancy, listResponsesByVacancy, listVacanciesByUser, openDb,
  putCard, putResponse, putVacancy, updateResponseStatus, type Db,
} from '../src/db/index.js';
import {
  createVacancyFromCard, isValidStartPayload, MAX_SCORE, phoneFromVcf, scoreResponse, timeToFirstResponse,
  timeToHire, vacancyDeepLink, verifyContactSignature, type CandidateAnswers, type HiringContext,
} from '../src/services/hiring.js';

const TOKEN = 'unit-test-bot-token';
const PACKS = resolve(import.meta.dirname, '../../packs');

/** Бот-заглушка: сеть в тестах не трогаем, загрузка QR намеренно падает. */
const stubBot = {
  api: {
    uploadImage: async () => { throw new Error('upload disabled in tests'); },
    sendMessageToChat: async () => ({ body: { mid: 'mid.test' } }),
    sendMessageToUser: async () => ({ body: { mid: 'mid.test' } }),
  },
} as unknown as Bot;

function testConfig(extra: Record<string, string> = {}): Config {
  return loadConfig({ MAX_UPDATES_MODE: 'none', PACKS_DIR: PACKS, SESSION_SECRET: 'test', MAX_BOT_TOKEN: TOKEN, DATA_DIR: '/tmp/stavka-test-hiring', ...extra });
}

/** Минимальная карточка рынка: публикации вакансии хватает этих полей. */
function cardPayload(id: string) {
  return {
    cardId: id,
    card: {
      professionKey: 'povar', professionTitle: 'Повар', regionCode: '7800000000000',
      sample: { fetched: 300, vacancies: 258, employers: 234, topEmployerShare: 4, dropped: {} },
      confidence: 'ok', confidenceReason: null,
      stats: { n: 258, median: 65000, p25: 45625, p75: 75000, min: 20000, max: 150000, mean: 66000 },
      fixedShare: 35, recentMedian: null,
      offer: { value: 45000, percentile: 22, band: 'low', shareAbove: 75 },
      options: [
        { kind: 'keep', value: 45000, percentile: 22, label: 'оставить' },
        { kind: 'median', value: 66000, percentile: 50, label: 'выйти на медиану' },
        { kind: 'top', value: 76000, percentile: 75, label: 'верхняя четверть' },
      ],
      histogram: [], byCategory: [], sameSize: null, examples: [],
      requirements: [{ key: 'medbook', label: 'медкнижка', count: 100, share: 40 }],
      schedules: [{ label: 'Сменный график', share: 60 }],
      verdict: 'Ниже рынка',
    },
    pack: { id: 'spb-obschepit', title: 'Общепит · Санкт-Петербург', version: 1 },
    profession: { key: 'povar', title: 'Повар', query: 'повар', synonyms: [], exclude: [] },
    region: { code: '7800000000000', fnsCode: '78', name: 'Санкт-Петербург', avgSalary: 90000, unemployment: null },
    profile: { inn: '7801633015', name: 'ООО «Малый 43»', inRegistry: true, category: 1, okved: '56.10', okvedName: null, fnsRegionCode: '78', kind: 'UL', registeredAt: null, active: true, fetchedAt: new Date().toISOString() },
    sources: [], fetched: { total: 702, records: 300, cacheHit: false, fetchedAt: new Date().toISOString() },
    closure: null, createdAt: new Date().toISOString(),
  };
}

describe('hiring: правила и хранилище', () => {
  const db: Db = openDb(':memory:');
  const ctx: HiringContext = { db, config: testConfig(), bot: stubBot, botUsername: 'test_bot' };

  it('считает балл отклика детерминированно', () => {
    const vacancy = { salary: 60000 };
    // Максимум: опыт 3+ (3×2), график (+3), ставка в пределах +10 % (+3), номер (+1).
    expect(scoreResponse(vacancy, { experience: 'senior', schedule: true, expectedSalary: 60000 }, true)).toBe(MAX_SCORE);
    // «Как в вакансии» = ставка вакансии.
    expect(scoreResponse(vacancy, { experience: 'senior', schedule: true, expectedSalary: null }, true)).toBe(MAX_SCORE);
    // Минимум: без опыта, не готов к графику, ожидания выше +30 %, без номера.
    expect(scoreResponse(vacancy, { experience: 'none', schedule: false, expectedSalary: 100000 }, false)).toBe(0);
    // Опыт ×2.
    expect(scoreResponse(vacancy, { experience: 'lt1', schedule: false, expectedSalary: 100000 }, false)).toBe(2);
    expect(scoreResponse(vacancy, { experience: 'mid', schedule: false, expectedSalary: 100000 }, false)).toBe(4);
    // Ожидания до +30 % дают +1, номер ещё +1.
    expect(scoreResponse(vacancy, { experience: 'none', schedule: false, expectedSalary: 78000 }, false)).toBe(1);
    expect(scoreResponse(vacancy, { experience: 'none', schedule: false, expectedSalary: 78001 }, false)).toBe(0);
    expect(scoreResponse(vacancy, { experience: 'none', schedule: false, expectedSalary: 66000 }, true)).toBe(4);
    // Без ставки в вакансии зарплатные баллы не начисляем.
    expect(scoreResponse({ salary: null }, { experience: 'senior', schedule: true, expectedSalary: 10 }, true)).toBe(10);
  });

  it('создаёт вакансию и валидный диплинк', () => {
    const { vacancy, link, payload } = createVacancyFromCard(ctx, {
      card: { cardId: 'card-1', professionKey: 'povar', professionTitle: 'Повар', regionCode: '7800000000000', regionName: 'Санкт-Петербург', employerName: 'ООО «Малый 43»' },
      maxUserId: 501,
      salary: 66000,
      text: 'Повар — Санкт-Петербург\n\nЗарплата: от 66 000 ₽',
    });
    expect(payload).toMatch(/^vac_[0-9a-f]{32}$/);
    expect(payload.length).toBeLessThanOrEqual(128);
    expect(isValidStartPayload(payload)).toBe(true);
    expect(link).toBe(`https://max.ru/test_bot?start=${payload}`);
    expect(vacancyDeepLink('test_bot', vacancy.id)).toBe(link);
    expect(getVacancy(db, vacancy.id)).toMatchObject({ maxUserId: 501, status: 'open', salary: 66000, title: 'Повар' });
  });

  it('хранит отклики, считает счётчики и метрики', () => {
    const v = putVacancy(db, { id: 'vac-crud', maxUserId: 501, cardId: null, professionKey: 'povar', regionCode: '7800000000000', title: 'Повар', salary: 60000, text: 'текст', employerName: null });
    expect(timeToFirstResponse(v)).toBeNull();
    expect(timeToHire(v)).toBeNull();

    const answers: CandidateAnswers = { experience: 'mid', schedule: true, expectedSalary: 62000 };
    const weak = putResponse(db, { id: 'r-weak', vacancyId: v.id, candidateUserId: 900, candidateName: 'Слабый', answers: { experience: 'none', schedule: false, expectedSalary: 200000 }, phone: null, phoneVerified: false, score: 0 });
    const strong = putResponse(db, { id: 'r-strong', vacancyId: v.id, candidateUserId: 901, candidateName: 'Сильный', answers, phone: '+79990000000', phoneVerified: true, score: scoreResponse(v, answers, true) });
    expect(strong.score).toBe(11);
    expect(strong.phoneVerified).toBe(true);
    expect(weak.status).toBe('new');

    // Сортировка по совпадению, потом по времени.
    expect(listResponsesByVacancy(db, v.id).map((r) => r.id)).toEqual(['r-strong', 'r-weak']);
    expect(findResponseByCandidate(db, v.id, 901)?.id).toBe('r-strong');
    expect(findResponseByCandidate(db, v.id, 777)).toBeNull();

    const listed = listVacanciesByUser(db, 501).find((x) => x.id === v.id)!;
    expect(listed.responses).toBe(2);
    expect(listed.newResponses).toBe(2);
    // Время до первого отклика проставилось автоматически.
    expect(getVacancy(db, v.id)!.firstResponseAt).not.toBeNull();
    expect(timeToFirstResponse(getVacancy(db, v.id)!)).toBeGreaterThanOrEqual(0);

    expect(updateResponseStatus(db, 'r-strong', 'invited')!.status).toBe('invited');
    expect(listVacanciesByUser(db, 501).find((x) => x.id === v.id)!.newResponses).toBe(1);

    // Закрыть может только владелец.
    expect(closeVacancy(db, v.id, 999)).toBeNull();
    const closed = closeVacancy(db, v.id, 501, 'r-strong')!;
    expect(closed.status).toBe('closed');
    expect(closed.hiredResponseId).toBe('r-strong');
    expect(timeToHire(closed)).toBeGreaterThanOrEqual(0);
  });

  it('проверяет подпись контакта MAX', () => {
    const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Иван Петров\r\nTEL;TYPE=CELL:+79990000000\r\nEND:VCARD';
    const good = createHmac('sha256', TOKEN).update(vcf.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
    expect(verifyContactSignature(TOKEN, vcf, good)).toBe(true);
    expect(verifyContactSignature(TOKEN, vcf, good.toUpperCase())).toBe(true);
    // Тот же ключ и текст, но в base64 — тоже принимаем.
    const base64 = createHmac('sha256', TOKEN).update(vcf.replace(/\r\n/g, '\n'), 'utf8').digest('base64');
    expect(verifyContactSignature(TOKEN, vcf, base64)).toBe(true);
    // Негатив: подделанный номер, чужой токен, пустая подпись.
    expect(verifyContactSignature(TOKEN, vcf.replace('+79990000000', '+79991111111'), good)).toBe(false);
    expect(verifyContactSignature('other-token', vcf, good)).toBe(false);
    expect(verifyContactSignature(TOKEN, vcf, null)).toBe(false);
    expect(verifyContactSignature(TOKEN, vcf, 'deadbeef')).toBe(false);
    // Телефон достаём из vCard.
    expect(phoneFromVcf(vcf)).toBe('+79990000000');
    expect(phoneFromVcf('BEGIN:VCARD\r\nEND:VCARD')).toBeNull();
  });
});

describe('hiring: API', () => {
  let parts: AppParts;
  let token: string;

  beforeAll(async () => {
    const config = testConfig();
    parts = await buildApp({ config, dbPath: ':memory:', bot: { username: 'test_bot', userId: 1 }, logger: false, webDist: '/nonexistent' });
    parts.apiDeps.hiring = { db: parts.db, config, bot: stubBot, botUsername: 'test_bot' };
    const now = Math.floor(Date.now() / 1000);
    const initData = buildSignedInitData(TOKEN, { auth_date: String(now), chat: '{"id":777,"type":"DIALOG"}', query_id: 'q', user: '{"id":4242,"first_name":"Тест"}' });
    token = (await parts.app.inject({ method: 'POST', url: '/api/session', payload: { initData } })).json().token as string;
    putCard(parts.db, { id: 'card-api', maxUserId: 4242, inn: '7801633015', packId: 'spb-obschepit', professionKey: 'povar', regionCode: '7800000000000', offer: 45000, payload: cardPayload('card-api') });
  });
  afterAll(async () => { await parts.app.close(); parts.db.close(); });

  const post = (url: string, body: unknown, t?: string) => parts.app.inject({ method: 'POST', url, payload: body, headers: t ? { authorization: `Bearer ${t}` } : {} });
  const get = (url: string, t?: string) => parts.app.inject({ method: 'GET', url, headers: t ? { authorization: `Bearer ${t}` } : {} });

  it('отклоняет публикацию вакансии в демо-режиме понятным сообщением', async () => {
    const demo = (await post('/api/session', {})).json().token as string;
    const r = await post('/api/cards/card-api/vacancy', { salary: 66000 }, demo);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('demo');
    expect(r.json().message).toContain('только внутри MAX');
    // Список вакансий в демо-режиме пустой, но не падает.
    const list = await get('/api/vacancies', demo);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ vacancies: [], demo: true });
  });

  it('публикует вакансию из карточки и возвращает диплинк', async () => {
    const r = await post('/api/cards/card-api/vacancy', { salary: 66000 }, token);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.link).toMatch(/^https:\/\/max\.ru\/test_bot\?start=vac_[0-9a-f]{32}$/);
    expect(body.qrSent).toBe(false); // загрузка QR в тестах отключена
    expect(body.vacancy).toMatchObject({ title: 'Повар', regionName: 'Санкт-Петербург', salary: 66000, status: 'open', responses: 0 });
    expect(body.vacancy.text).toContain('Зарплата: от');

    const list = await get('/api/vacancies', token);
    expect(list.json().vacancies.map((v: { id: string }) => v.id)).toContain(body.vacancy.id);

    const responses = await get(`/api/vacancies/${body.vacancy.id}/responses`, token);
    expect(responses.statusCode).toBe(200);
    expect(responses.json().responses).toEqual([]);

    const closed = await post(`/api/vacancies/${body.vacancy.id}/close`, {}, token);
    expect(closed.json().vacancy.status).toBe('closed');
  });

  it('проверяет права: чужая вакансия и чужой отклик недоступны', async () => {
    putVacancy(parts.db, { id: 'vac-foreign', maxUserId: 999, cardId: null, professionKey: 'povar', regionCode: '7800000000000', title: 'Повар', salary: 60000, text: 'текст', employerName: null });
    putResponse(parts.db, { id: 'resp-foreign', vacancyId: 'vac-foreign', candidateUserId: 555, candidateName: 'Чужой', answers: { experience: 'mid', schedule: true, expectedSalary: null }, phone: null, phoneVerified: false, score: 7 });
    expect((await get('/api/vacancies/vac-foreign/responses', token)).statusCode).toBe(403);
    expect((await post('/api/vacancies/vac-foreign/close', {}, token)).statusCode).toBe(403);
    expect((await post('/api/responses/resp-foreign/invite', { message: 'приходите' }, token)).statusCode).toBe(403);
    expect((await post('/api/responses/resp-foreign/reject', {}, token)).statusCode).toBe(403);
    expect((await post('/api/responses/resp-foreign/hire', {}, token)).statusCode).toBe(403);
    // Несуществующие идентификаторы — 404, без сессии — 401.
    expect((await get('/api/vacancies/nope/responses', token)).statusCode).toBe(404);
    expect((await post('/api/responses/nope/invite', {}, token)).statusCode).toBe(404);
    expect((await get('/api/vacancies')).statusCode).toBe(401);
  });

  it('проводит отклик через приглашение, отказ и найм', async () => {
    const pub = (await post('/api/cards/card-api/vacancy', {}, token)).json();
    const vacancyId = pub.vacancy.id as string;
    const answers: CandidateAnswers = { experience: 'senior', schedule: true, expectedSalary: null };
    putResponse(parts.db, { id: 'resp-a', vacancyId, candidateUserId: 601, candidateName: 'Анна', answers, phone: '+79990000001', phoneVerified: true, score: MAX_SCORE });
    putResponse(parts.db, { id: 'resp-b', vacancyId, candidateUserId: 602, candidateName: 'Борис', answers: { experience: 'none', schedule: false, expectedSalary: 200000 }, phone: null, phoneVerified: false, score: 0 });

    const listed = (await get(`/api/vacancies/${vacancyId}/responses`, token)).json();
    expect(listed.responses.map((r: { id: string }) => r.id)).toEqual(['resp-a', 'resp-b']);
    expect(listed.responses[0]).toMatchObject({ score: MAX_SCORE, maxScore: MAX_SCORE, experienceLabel: '3 года и больше', phoneVerified: true });
    expect(listed.vacancy.metrics.timeToFirstResponseMin).toBeGreaterThanOrEqual(0);

    expect((await post('/api/responses/resp-a/invite', { message: 'завтра в 11:00' }, token)).json().response.status).toBe('invited');
    expect((await post('/api/responses/resp-b/reject', {}, token)).json().response.status).toBe('rejected');
    const hired = (await post('/api/responses/resp-a/hire', {}, token)).json();
    expect(hired.response.status).toBe('hired');
    expect(hired.vacancy).toMatchObject({ status: 'closed', hiredResponseId: 'resp-a' });
    expect(hired.vacancy.metrics.timeToHireMin).toBeGreaterThanOrEqual(0);
  });
});
