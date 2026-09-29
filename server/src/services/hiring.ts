/**
 * Отклики и найм: публикация вакансии (диплинк + QR), детерминированная оценка
 * откликов, проверка подписи контакта MAX и сообщения участникам найма.
 *
 * Генеративных моделей здесь нет: и черновик вакансии, и балл отклика выводимы
 * из правил, записанных в этом файле.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import type { Bot } from '@maxhub/max-bot-api';
import { Keyboard } from '@maxhub/max-bot-api';
import type { Db, ResponseRow, VacancyRow } from '../db/index.js';
import { findResponseByCandidate, getUser, getVacancy, HiringStateError, putResponse, putVacancy } from '../db/index.js';
import type { Config } from '../config.js';

export interface HiringContext { db: Db; config: Config; bot: Bot; botUsername: string }

/** Ответы кандидата на три вопроса. */
export type ExperienceKey = 'none' | 'lt1' | 'mid' | 'senior';
export interface CandidateAnswers {
  /** Опыт: нет / до года / 1–3 года / 3 года и больше. */
  experience: ExperienceKey;
  /** Готов работать по графику вакансии. */
  schedule: boolean;
  /** Ожидаемая ставка, ₽/мес; null – «как в вакансии». */
  expectedSalary: number | null;
}

export const EXPERIENCE_LABEL: Record<ExperienceKey, string> = {
  none: 'без опыта',
  lt1: 'до года',
  mid: '1–3 года',
  senior: '3 года и больше',
};

/** Баллы за опыт (умножаются на 2 в итоговом балле). */
const EXPERIENCE_POINTS: Record<ExperienceKey, number> = { none: 0, lt1: 1, mid: 2, senior: 3 };

/** Максимально возможный балл: опыт 3×2 + график 3 + ставка 3 + номер 1. */
export const MAX_SCORE = 13;

/**
 * Детерминированная оценка отклика (не нейросеть): опыт ×2, готовность к графику,
 * попадание ожиданий в ставку вакансии, наличие номера телефона.
 */
export function scoreResponse(vacancy: { salary: number | null }, answers: CandidateAnswers, phoneShared: boolean): number {
  let score = (EXPERIENCE_POINTS[answers.experience] ?? 0) * 2;
  if (answers.schedule) score += 3;
  const salary = vacancy.salary;
  if (salary != null && salary > 0) {
    // «Как в вакансии» – это ровно ставка вакансии.
    const expected = answers.expectedSalary == null ? salary : answers.expectedSalary;
    if (expected <= salary * 1.1) score += 3;
    else if (expected <= salary * 1.3) score += 1;
  }
  if (phoneShared) score += 1;
  return score;
}

/** Идентификатор вакансии без дефисов: помещается в start-payload (≤ 128, [A-Za-z0-9_-]). */
export function newVacancyId(): string {
  return randomUUID().replace(/-/g, '');
}

export function vacancyStartPayload(vacancyId: string): string {
  return `vac_${vacancyId}`;
}

export function inboxStartPayload(vacancyId: string): string {
  return `inbox_${vacancyId}`;
}

const PAYLOAD_RE = /^[A-Za-z0-9_-]{1,128}$/;
export function isValidStartPayload(payload: string): boolean {
  return PAYLOAD_RE.test(payload);
}

/** Диплинк на бота с параметром запуска: кандидат открывает вакансию по ссылке или QR. */
export function vacancyDeepLink(botUsername: string, vacancyId: string): string {
  return `https://max.ru/${botUsername}?start=${vacancyStartPayload(vacancyId)}`;
}

export interface CreateVacancyInput {
  card: {
    cardId: string;
    professionKey: string;
    professionTitle: string;
    regionCode: string;
    regionName: string;
    employerName: string | null;
  };
  maxUserId: number;
  salary: number | null;
  text: string;
  listed?: boolean;
  /** Stable server-derived identifier for an HTTP retry; never a client-selected database key. */
  id?: string;
}

export interface CreatedVacancy { vacancy: VacancyRow; link: string; payload: string }

/** Создаёт вакансию из карточки рынка и возвращает её вместе с диплинком. */
export function createVacancyFromCard(ctx: HiringContext, input: CreateVacancyInput): CreatedVacancy {
  const id = input.id ?? newVacancyId();
  const payload = vacancyStartPayload(id);
  if (!isValidStartPayload(payload)) throw new Error(`Некорректный параметр запуска: ${payload}`);
  const vacancy = putVacancy(ctx.db, {
    id,
    maxUserId: input.maxUserId,
    cardId: input.card.cardId,
    professionKey: input.card.professionKey,
    regionCode: input.card.regionCode,
    title: input.card.professionTitle,
    salary: input.salary,
    text: input.text,
    employerName: input.card.employerName,
    listed: input.listed ?? false,
  });
  return { vacancy, link: vacancyDeepLink(ctx.botUsername, id), payload };
}

/**
 * QR-код диплинка в PNG-файл. Пишем именно файл, а не Buffer: при загрузке Buffer
 * SDK даёт случайное имя без расширения, и MAX отказывается принимать картинку.
 */
export async function renderVacancyQr(ctx: { config: Config }, vacancyId: string, link: string): Promise<string> {
  const dir = join(ctx.config.dataDir, 'qr');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `vacancy-${vacancyId}.png`);
  await QRCode.toFile(path, link, { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'M' });
  return path;
}

/**
 * Проверка подписи контакта MAX: hash = HMAC-SHA256(ключ – токен бота,
 * сообщение – vcf_info с переводами строк \n). Не сошлось – сохраняем номер
 * как непроверенный, но отклик не теряем.
 */
export function verifyContactSignature(botToken: string, vcfInfo: string, hash: string | null | undefined): boolean {
  if (!hash || !botToken || !vcfInfo) return false;
  const message = vcfInfo.replace(/\r\n/g, '\n');
  const mac = createHmac('sha256', botToken).update(message, 'utf8').digest();
  const given = hash.trim();
  const candidates = [mac.toString('hex'), mac.toString('base64'), mac.toString('base64url')];
  return candidates.some((expected) => {
    // Только hex нечувствителен к регистру; base64/base64url чувствительны.
    const hex = expected === candidates[0];
    const a = Buffer.from(hex ? expected.toLowerCase() : expected);
    const b = Buffer.from(hex ? given.toLowerCase() : given);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/** Телефон из vCard: строка вида TEL;...:+79990000000. */
export function phoneFromVcf(vcfInfo: string): string | null {
  const m = /^TEL[^:\r\n]*:(.+)$/im.exec(vcfInfo.replace(/\r\n/g, '\n'));
  if (!m) return null;
  const raw = m[1]!.trim();
  const digits = raw.replace(/[^\d+]/g, '');
  return digits || null;
}

/* ---------- метрики найма ---------- */

/** Время до первого отклика, минут (null – откликов ещё не было). */
export function timeToFirstResponse(v: Pick<VacancyRow, 'createdAt' | 'firstResponseAt'>): number | null {
  if (!v.firstResponseAt) return null;
  return Math.max(0, Math.round((Date.parse(v.firstResponseAt) - Date.parse(v.createdAt)) / 60_000));
}

/** Срок закрытия вакансии, минут (null – вакансия ещё открыта). */
export function timeToHire(v: Pick<VacancyRow, 'createdAt' | 'closedAt' | 'hiredResponseId'>): number | null {
  if (!v.closedAt || !v.hiredResponseId) return null;
  return Math.max(0, Math.round((Date.parse(v.closedAt) - Date.parse(v.createdAt)) / 60_000));
}

/** Общий атомарный путь сохранения отклика для чата и мини-приложения. Повтор возвращает ту же запись. */
export function submitCandidateResponse(db: Db, uid: number, vacancyId: string, answers: CandidateAnswers, phone: string | null = null, phoneVerified = false): { response: ResponseRow<CandidateAnswers>; vacancy: VacancyRow; created: boolean } {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = findResponseByCandidate<CandidateAnswers>(db, vacancyId, uid);
    const vacancy = getVacancy(db, vacancyId);
    if (!vacancy) throw new HiringStateError('Вакансия не найдена');
    if (vacancy.maxUserId === uid) throw new HiringStateError('Нельзя откликнуться на собственную вакансию');
    if (existing) { db.exec('COMMIT'); return { response: existing, vacancy, created: false }; }
    if (vacancy.status !== 'open') throw new HiringStateError('Вакансия уже закрыта');
    const response = putResponse<CandidateAnswers>(db, { id: randomUUID(), vacancyId, candidateUserId: uid, candidateName: getUser(db, uid)?.name ?? null,
      answers, phone, phoneVerified, score: scoreResponse(vacancy, answers, Boolean(phone)) });
    db.exec('COMMIT');
    return { response, vacancy: getVacancy(db, vacancyId)!, created: true };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Человекочитаемая длительность: «12 мин», «3 ч 20 мин», «2 дн 4 ч». */
export function formatDuration(minutes: number | null): string {
  if (minutes == null) return '–';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч${minutes % 60 ? ` ${minutes % 60} мин` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days} дн${hours % 24 ? ` ${hours % 24} ч` : ''}`;
}

/* ---------- отправка сообщений с учётом лимита 2 сообщения в секунду на чат ---------- */

const sendQueues = new Map<number, Promise<unknown>>();
const lastSentAt = new Map<number, number>();
const MIN_GAP_MS = 550;

/** Ставит отправку в очередь по получателю: MAX разрешает 2 сообщения в секунду на чат. */
export function throttleByChat<T>(key: number, fn: () => Promise<T>): Promise<T> {
  const prev = sendQueues.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - (lastSentAt.get(key) ?? 0));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { lastSentAt.set(key, Date.now()); }
  });
  sendQueues.set(key, next.catch(() => undefined));
  return next;
}

type SendExtra = Parameters<Bot['api']['sendMessageToUser']>[2];

/** Сообщение пользователю (кандидату или работодателю) в его личный диалог с ботом. */
export function sendToUser(ctx: HiringContext, userId: number, text: string, extra?: SendExtra) {
  return throttleByChat(userId, () => ctx.bot.api.sendMessageToUser(userId, text, extra));
}

/** Кнопка «Отклики»: открывает инбокс вакансии в мини-приложении. */
export function inboxButton(botUsername: string, vacancyId: string, text = 'Вакансии и отклики') {
  return Keyboard.button.openApp(text, botUsername, undefined, inboxStartPayload(vacancyId));
}

/** Сводка отклика для уведомления работодателя: балл совпадения объяснён словами. */
export function responseSummary(r: ResponseRow<CandidateAnswers>, vacancy: VacancyRow): string {
  const a = r.answers;
  let expected = 'как в вакансии';
  if (a.expectedSalary != null) {
    const rub = `${a.expectedSalary.toLocaleString('ru-RU')} ₽`;
    if (vacancy.salary && vacancy.salary > 0) {
      const diff = Math.round((100 * (a.expectedSalary - vacancy.salary)) / vacancy.salary);
      expected = diff > 0 ? `${rub}, на ${diff} % выше ставки вакансии` : `${rub}, в пределах ставки вакансии`;
    } else expected = rub;
  }
  const phone = r.phone ? (r.phoneVerified ? r.phone : `${r.phone} (подпись MAX не подтверждена)`) : 'не оставил, ответьте сообщением в MAX';
  return [
    `📥 Новый отклик на вакансию «${vacancy.title}»`,
    `${r.candidateName ?? 'Кандидат'}: совпадение с вакансией ${r.score} из ${MAX_SCORE}. Чем выше балл, тем ближе кандидат к вашим условиям: опыт, график, ожидания по деньгам и есть ли номер.`,
    `Опыт: ${EXPERIENCE_LABEL[a.experience] ?? a.experience}. График: ${a.schedule ? 'подходит' : 'не подходит'}. Ожидания по ставке: ${expected}. Телефон: ${phone}.`,
    '',
    'Что дальше: откройте «Вакансии и отклики», там можно пригласить на собеседование, отказать или принять на работу.',
  ].join('\n');
}
