import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { Bot } from '@maxhub/max-bot-api';
import { buildApp, type AppParts } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildSignedInitData } from '../src/api/auth.js';
import { closeVacancy, getResponse, getVacancy, listOpenJobs, putCard, putResponse, putVacancy, setVacancyListed, upsertUser } from '../src/db/index.js';
import type { MarketResult } from '../src/services/market.js';
import { submitCandidateResponse, timeToHire } from '../src/services/hiring.js';

const TOKEN = 'jobs-test-token';
const OWNER = 801; const CANDIDATE = 802; const STRANGER = 803;
const answers = { experience: 'mid' as const, schedule: true, expectedSalary: null, consent: true as const };
let parts: AppParts;
let failSend = false;
let sends: number[] = [];
let tokens: Record<number, string> = {};
let demoToken = '';
const get = (path: string, uid = CANDIDATE) => parts.app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${tokens[uid]}` } });
const post = (path: string, body: unknown, uid = CANDIDATE) => parts.app.inject({ method: 'POST', url: path, payload: body, headers: { authorization: `Bearer ${tokens[uid]}` } });
const vacancy = (id: string, extra: Partial<Parameters<typeof putVacancy>[1]> = {}) => putVacancy(parts.db, {
  id, maxUserId: OWNER, cardId: 'private-card', professionKey: 'povar', title: 'Повар', regionCode: '7800000000000',
  salary: 60000, text: 'Работа поваром. График 2/2.', employerName: 'Тестовое кафе', listed: true, ...extra,
});
beforeEach(async () => {
  failSend = false; sends = []; tokens = {};
  const config = loadConfig({ MAX_UPDATES_MODE: 'none', SESSION_SECRET: 'jobs-test-session-secret-32-chars', MAX_BOT_TOKEN: TOKEN, PACKS_DIR: resolve(import.meta.dirname, '../../packs') });
  parts = await buildApp({ config, dbPath: ':memory:', bot: { username: 'test_bot', userId: 1 }, logger: false, webDist: '/nonexistent' });
  const bot = { api: { sendMessageToUser: async (uid: number) => { sends.push(uid); if (failSend) throw new Error('MAX unavailable'); return { body: { mid: 'test' } }; } } } as unknown as Bot;
  parts.apiDeps.bot = { username: 'test_bot', userId: 1 };
  parts.apiDeps.hiring = { db: parts.db, config, bot, botUsername: 'test_bot' };
  const payload = { cardId: 'salary-card', card: { offer: { value: 55000 }, stats: { median: 60000 }, options: [{ kind: 'median', value: 60000 }] }, pack: { id: 'generic' }, profession: { key: 'povar', title: 'Повар' }, region: { code: '7800000000000', name: 'Санкт-Петербург' }, profile: null } as unknown as MarketResult;
  putCard(parts.db, { id: 'salary-card', maxUserId: OWNER, inn: null, packId: 'generic', professionKey: 'povar', regionCode: '7800000000000', offer: 55000, payload });
  for (const uid of [OWNER, CANDIDATE, STRANGER]) {
    const initData = buildSignedInitData(TOKEN, { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: uid, first_name: `Тест ${uid}` }) });
    const session = await parts.app.inject({ method: 'POST', url: '/api/session', payload: { initData } });
    tokens[uid] = session.json().token;
  }
  demoToken = (await parts.app.inject({ method: 'POST', url: '/api/session', payload: {} })).json().token;
});
afterEach(async () => { await parts.app.close(); parts.db.close(); });

describe('публикация со своей зарплатой', () => {
  it('сохраняет любую допустимую сумму, свой текст и каталог; повтор HTTP не создаёт дубль', async () => {
    const body = { salary: 83000, text: 'Реальная смена 2/2. Зарплата 83 000 до НДФЛ.', listed: true, requestId: 'custom-salary-001' };
    const first = (await post('/api/cards/salary-card/vacancy', body, OWNER)).json();
    const second = (await post('/api/cards/salary-card/vacancy', body, OWNER)).json();
    expect(first.vacancy).toMatchObject({ salary: 83000, text: body.text, listed: true });
    expect(second).toMatchObject({ reused: true, vacancy: { id: first.vacancy.id } });
    expect((await get('/api/vacancies', OWNER)).json().vacancies).toHaveLength(1);
    expect((await post('/api/cards/salary-card/vacancy', { ...body, salary: 84000 }, OWNER)).statusCode).toBe(409);
  });
  it('не подменяет собственную ставку средней и отклоняет неверные суммы/текст', async () => {
    const own = (await post('/api/cards/salary-card/vacancy', { text: 'Тестовый текст' }, OWNER)).json();
    expect(own.vacancy.salary).toBe(55000);
    for (const salary of [0, 999, 5000001, 1234.5]) expect((await post('/api/cards/salary-card/vacancy', { salary }, OWNER)).statusCode).toBe(400);
    expect((await post('/api/cards/salary-card/vacancy', { salary: 83000 }, STRANGER)).statusCode).toBe(403);
    expect((await post('/api/cards/salary-card/vacancy', { text: {} }, OWNER)).statusCode).toBe(400);
  });
});

describe('каталог вакансий и права доступа', () => {
  it('без сессии каталог закрыт; демо может читать, но не откликаться', async () => {
    vacancy('public');
    expect((await parts.app.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(401);
    expect((await parts.app.inject({ method: 'GET', url: '/api/jobs', headers: { authorization: `Bearer ${demoToken}` } })).json().total).toBe(1);
    expect((await parts.app.inject({ method: 'POST', url: '/api/jobs/public/apply', payload: answers, headers: { authorization: `Bearer ${demoToken}` } })).statusCode).toBe(400);
  });
  it('старые и приватные вакансии не появляются автоматически', async () => {
    vacancy('public'); vacancy('private', { listed: false }); vacancy('closed'); closeVacancy(parts.db, 'closed', OWNER);
    const old = putVacancy(parts.db, { id: 'old', maxUserId: OWNER, cardId: null, professionKey: 'povar', title: 'Повар', regionCode: '7800000000000', salary: 50000, text: 'Личная ссылка', employerName: null });
    expect(old.listed).toBe(false);
    expect((await get('/api/jobs')).json().jobs.map((v: { id: string }) => v.id)).toEqual(['public']);
    expect((await get('/api/jobs/private')).statusCode).toBe(404);
  });
  it('ищет по кириллице без учёта регистра и ё/е; % и SQL не становятся операторами', async () => {
    vacancy('p'); vacancy('v', { title: 'ВОДИТЕЛЬ' }); vacancy('e', { title: 'Вахтёр' });
    expect((await get('/api/jobs?q=%D0%9F%D0%9E%D0%92')).json().total).toBe(1);
    expect(listOpenJobs(parts.db, { q: 'вахтер' }).vacancies[0]!.id).toBe('e');
    expect(listOpenJobs(parts.db, { q: "' OR 1=1 --" }).total).toBe(0);
    expect(listOpenJobs(parts.db, { q: '%' }).total).toBe(0);
  });
  it('находит вакансию по названию работодателя, а не только по должности', async () => {
    vacancy('bakery', { title: 'Пекарь', employerName: 'Пекарня «Сдоба»' });
    vacancy('other', { title: 'Повар', employerName: null });
    expect(listOpenJobs(parts.db, { q: 'сдоба' }).vacancies.map((v) => v.id)).toEqual(['bakery']);
    expect(listOpenJobs(parts.db, { q: 'пекар' }).total).toBe(1);
  });
  it('фильтрует регион и зарплату, сохраняет стабильную пагинацию', async () => {
    for (let i = 0; i < 4; i++) vacancy(`v${i}`, { salary: 50000 + i * 10000 });
    vacancy('rt', { regionCode: '1600000000000', salary: 90000 }); vacancy('salary-null', { salary: null });
    const first = (await get('/api/jobs?region=78&minSalary=60000&limit=2')).json();
    const second = (await get('/api/jobs?region=78&minSalary=60000&limit=2&offset=2')).json();
    expect(first.total).toBe(3); expect(first.jobs).toHaveLength(2); expect(second.jobs).toHaveLength(1);
    expect(new Set([...first.jobs, ...second.jobs].map((v: { id: string }) => v.id)).size).toBe(3);
    expect((await get('/api/jobs?region=999')).statusCode).toBe(400);
    expect((await get('/api/jobs?limit=100000')).statusCode).toBe(400);
    expect((await get('/api/jobs?offset=-1')).statusCode).toBe(400);
  });
  it('DTO не раскрывает владельца, карточку рынка, телефоны и чужие отклики', async () => {
    vacancy('safe');
    putResponse(parts.db, { id: 'hidden-response', vacancyId: 'safe', candidateUserId: STRANGER, candidateName: 'Чужой кандидат', answers, phone: '+79990000000', phoneVerified: true, score: 10 });
    const list = (await get('/api/jobs')).json(); const detail = (await get('/api/jobs/safe')).json();
    for (const data of [list, detail]) {
      const text = JSON.stringify(data);
      for (const secret of ['private-card', 'hidden-response', '+79990000000', 'Чужой кандидат', 'maxUserId', 'candidateUserId', 'responses']) expect(text).not.toContain(secret);
    }
    expect(detail.job.myResponse).toBeNull();
    expect((await get('/api/vacancies/safe/responses')).statusCode).toBe(403);
  });
  it('размещать в каталоге и убирать может только владелец; закрытая не публикуется', async () => {
    vacancy('visible', { listed: false });
    expect((await post('/api/vacancies/visible/listing', { listed: true })).statusCode).toBe(404);
    expect((await post('/api/vacancies/visible/listing', { listed: 'true' }, OWNER)).statusCode).toBe(400);
    expect((await post('/api/vacancies/visible/listing', { listed: true }, OWNER)).json().listed).toBe(true);
    expect((await get('/api/jobs')).json().total).toBe(1);
    expect((await post('/api/vacancies/visible/listing', { listed: false }, OWNER)).json().listed).toBe(false);
    closeVacancy(parts.db, 'visible', OWNER);
    expect((await post('/api/vacancies/visible/listing', { listed: true }, OWNER)).statusCode).toBe(409);
  });
});

describe('отклики и решения работодателя', () => {
  it('без подтверждения и с некорректными ответами отклик не создаётся', async () => {
    vacancy('v');
    expect((await post('/api/jobs/v/apply', { ...answers, consent: false })).statusCode).toBe(400);
    expect((await post('/api/jobs/v/apply', { ...answers, experience: 'bad' })).statusCode).toBe(400);
    expect((await post('/api/jobs/v/apply', { ...answers, expectedSalary: 1 })).statusCode).toBe(400);
    expect((await post('/api/jobs/v/apply', answers, OWNER)).json().error).toBe('own_vacancy');
  });
  it('создаёт отклик один раз, показывает личный статус и уведомляет только нужного работодателя', async () => {
    vacancy('v');
    const first = (await post('/api/jobs/v/apply', answers)).json(); const second = (await post('/api/jobs/v/apply', answers)).json();
    expect(first).toMatchObject({ created: true, employerNotified: true });
    expect(second).toMatchObject({ created: false, response: first.response });
    expect(sends).toEqual([OWNER]);
    expect((await get('/api/jobs/v')).json().job.myResponse).toBe('new');
    expect((await get('/api/jobs/v', STRANGER)).json().job.myResponse).toBeNull();
    expect((await get('/api/vacancies/v/responses', OWNER)).json().responses).toHaveLength(1);
  });
  it('закрытие между просмотром и откликом даёт 409, не создавая запись', async () => {
    vacancy('v'); expect((await get('/api/jobs/v')).statusCode).toBe(200);
    closeVacancy(parts.db, 'v', OWNER);
    expect((await post('/api/jobs/v/apply', answers)).statusCode).toBe(409);
    expect(sends).toEqual([]);
  });
  it('при ошибке MAX отклик остаётся в инбоксе без ложного подтверждения доставки', async () => {
    vacancy('v'); failSend = true;
    const response = (await post('/api/jobs/v/apply', answers)).json();
    expect(response).toMatchObject({ created: true, employerNotified: false });
    expect(getResponse(parts.db, response.response.id)).not.toBeNull();
  });
  it('найм атомарный: второй кандидат не может стать нанятым, повтор первого не шлёт сообщение', async () => {
    vacancy('v');
    const a = submitCandidateResponse(parts.db, CANDIDATE, 'v', answers).response;
    const b = submitCandidateResponse(parts.db, STRANGER, 'v', answers).response;
    expect((await post(`/api/responses/${a.id}/hire`, {}, OWNER)).statusCode).toBe(200);
    expect((await post(`/api/responses/${b.id}/hire`, {}, OWNER)).statusCode).toBe(409);
    expect(getResponse(parts.db, b.id)!.status).toBe('new');
    expect(getVacancy(parts.db, 'v')!.hiredResponseId).toBe(a.id);
    const before = sends.length;
    expect((await post(`/api/responses/${a.id}/hire`, {}, OWNER)).json().delivery).toBe('unchanged');
    expect(sends.length).toBe(before);
    expect((await post(`/api/responses/${a.id}/invite`, {}, OWNER)).statusCode).toBe(409);
  });
  it('отказ терминальный; чужой владелец не изменяет решение, приглашение проверяет длину', async () => {
    vacancy('v'); const a = submitCandidateResponse(parts.db, CANDIDATE, 'v', answers).response;
    expect((await post(`/api/responses/${a.id}/hire`, {}, STRANGER)).statusCode).toBe(403);
    expect((await post(`/api/responses/${a.id}/invite`, { message: 12 }, OWNER)).statusCode).toBe(400);
    expect((await post(`/api/responses/${a.id}/invite`, { message: 'a'.repeat(2001) }, OWNER)).statusCode).toBe(400);
    expect((await post(`/api/responses/${a.id}/reject`, {}, OWNER)).statusCode).toBe(200);
    expect((await post(`/api/responses/${a.id}/invite`, {}, OWNER)).statusCode).toBe(409);
  });
  it('отдельно сообщает ошибку отправки приглашения и не считает ручное закрытие наймом', async () => {
    vacancy('v'); const a = submitCandidateResponse(parts.db, CANDIDATE, 'v', answers).response; failSend = true;
    expect((await post(`/api/responses/${a.id}/invite`, {}, OWNER)).json().delivery).toBe('failed');
    const closed = closeVacancy(parts.db, 'v', OWNER)!;
    expect(timeToHire(closed)).toBeNull();
    expect((await get('/api/jobs')).json().total).toBe(0);
  });
});
