/** Каталог вакансий работодателей «Кадрового радара», не копия внешних агрегаторов. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Keyboard } from '@maxhub/max-bot-api';
import { z } from 'zod';
import type { ApiDeps } from './routes.js';
import type { SessionPayload } from './auth.js';
import { findResponseByCandidate, getVacancy, HiringStateError, listOpenJobs, setVacancyListed, type VacancyRow } from '../db/index.js';
import { inboxButton, responseSummary, sendToUser, submitCandidateResponse, vacancyDeepLink, type CandidateAnswers } from '../services/hiring.js';

const filtersSchema = z.object({
  q: z.string().max(120).optional(), region: z.string().max(20).optional(),
  minSalary: z.coerce.number().int().min(0).max(5_000_000).optional(),
  offset: z.coerce.number().int().min(0).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const answersSchema = z.object({
  experience: z.enum(['none', 'lt1', 'mid', 'senior']), schedule: z.boolean(),
  expectedSalary: z.number().int().min(1000).max(5_000_000).nullable(), consent: z.literal(true),
});

export function registerJobsApi(app: FastifyInstance, deps: ApiDeps, auth: (req: FastifyRequest, reply: FastifyReply) => SessionPayload | null): void {
  const { db, catalog } = deps;
  // Не переиспользовать DTO инбокса: в каталоге нет владельца, телефонов, чужих откликов и внутренних карточек.
  const view = (v: VacancyRow, uid: number, detail = false) => ({
    id: v.id, title: v.title, salary: v.salary, employerName: v.employerName,
    regionCode: v.regionCode, regionName: catalog.regions.find((r) => r.code === v.regionCode)?.name ?? v.regionCode,
    createdAt: v.createdAt, status: v.status, own: v.maxUserId === uid,
    link: deps.bot ? vacancyDeepLink(deps.bot.username, v.id) : null,
    ...(detail ? { text: v.text, myResponse: findResponseByCandidate(db, v.id, uid)?.status ?? null } : {}),
  });
  app.get('/api/jobs', async (req, reply) => {
    const session = auth(req, reply); if (!session) return;
    const parsed = filtersSchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'filters_invalid', message: 'Проверьте фильтры поиска вакансий' });
    const f = parsed.data;
    const region = f.region ? catalog.regions.find((r) => r.fnsCode === f.region || r.code === f.region) : null;
    if (f.region && !region) return reply.code(400).send({ error: 'region_unknown', message: 'Регион не найден' });
    const result = listOpenJobs(db, { q: f.q, regionCode: region?.code, minSalary: f.minSalary, offset: f.offset, limit: f.limit });
    return { jobs: result.vacancies.map((v) => view(v, session.uid)), total: result.total, offset: f.offset ?? 0, limit: f.limit ?? 12 };
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const session = auth(req, reply); if (!session) return;
    const vacancy = getVacancy(db, req.params.id);
    if (!vacancy || (!vacancy.listed && vacancy.maxUserId !== session.uid)) return reply.code(404).send({ error: 'not_found', message: 'Вакансия не найдена в каталоге' });
    return { job: view(vacancy, session.uid, true) };
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/jobs/:id/apply', async (req, reply) => {
    const session = auth(req, reply); if (!session) return;
    if (session.demo || session.uid <= 0) return reply.code(400).send({ error: 'demo', message: 'Откликнуться можно только внутри MAX' });
    const parsed = answersSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'answers_invalid', message: 'Ответьте на три вопроса и подтвердите передачу отклика выбранному работодателю' });
    const vacancy = getVacancy(db, req.params.id);
    if (!vacancy?.listed) return reply.code(404).send({ error: 'not_found', message: 'Вакансия не найдена в каталоге' });
    if (vacancy.maxUserId === session.uid) return reply.code(409).send({ error: 'own_vacancy', message: 'Это ваша вакансия: отклики смотрите в разделе работодателя' });
    const existing = findResponseByCandidate<CandidateAnswers>(db, vacancy.id, session.uid);
    if (!existing && vacancy.status !== 'open') return reply.code(409).send({ error: 'vacancy_closed', message: 'Вакансия уже закрыта' });
    const { consent: _consent, ...answers } = parsed.data;
    let result: ReturnType<typeof submitCandidateResponse>;
    try { result = submitCandidateResponse(db, session.uid, vacancy.id, answers); }
    catch (e) {
      if (e instanceof HiringStateError) return reply.code(409).send({ error: 'hiring_conflict', message: e.message });
      throw e;
    }
    let employerNotified = false;
    if (result.created && deps.hiring && deps.bot) {
      try {
        await sendToUser(deps.hiring, vacancy.maxUserId, responseSummary(result.response, vacancy), {
          attachments: [Keyboard.inlineKeyboard([[inboxButton(deps.bot.username, vacancy.id)]])],
        });
        employerNotified = true;
      } catch { app.log.warn({ vacancyId: vacancy.id }, 'отклик сохранён, уведомление работодателю не отправлено'); }
    }
    // Отклик уже в инбоксе даже при ошибке MAX API; не обещаем фактическую доставку сообщения.
    return { response: { id: result.response.id, status: result.response.status }, created: result.created, employerNotified };
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/vacancies/:id/listing', async (req, reply) => {
    const session = auth(req, reply); if (!session) return;
    if (session.demo || session.uid <= 0) return reply.code(400).send({ error: 'demo', message: 'Управление вакансией доступно только внутри MAX' });
    const parsed = z.object({ listed: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'listing_invalid', message: 'Укажите, показывать ли вакансию в каталоге' });
    const v = getVacancy(db, req.params.id);
    if (!v || v.maxUserId !== session.uid) return reply.code(404).send({ error: 'not_found', message: 'Вакансия не найдена' });
    if (v.status !== 'open') return reply.code(409).send({ error: 'vacancy_closed', message: 'Закрытую вакансию нельзя разместить в каталоге' });
    return { listed: setVacancyListed(db, v.id, session.uid, parsed.data.listed)!.listed };
  });
}
