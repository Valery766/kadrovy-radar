/** Конфигурация из переменных окружения. Секреты никогда не логируются. */
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export type UpdatesMode = 'webhook' | 'polling' | 'none';

export interface Config {
  botToken: string | null;
  webhookSecret: string | null;
  updatesMode: UpdatesMode;
  publicUrl: string;
  port: number;
  host: string;
  dataDir: string;
  sessionSecret: string;
  apiBase: string;
  logLevel: string;
  packsDir: string;
  /** Срок свежести кэша вакансий, часов. */
  vacancyCacheHours: number;
  /** Срок свежести профиля из реестра МСП, часов. */
  profileCacheHours: number;
  /** Сколько записей максимум забирать у источника вакансий на один запрос. */
  maxVacancyRecords: number;
  /** Сколько работодателей обогащать через ФНС на одну карточку. */
  maxEmployersToEnrich: number;
  /** Год плана проверок ЕРКНМ (по умолчанию текущий). */
  inspectionsYear: number;
  /** Через сколько дней набор ЕРКНМ считается устаревшим и проверяется новая версия. */
  inspectionsMaxAgeDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.MAX_UPDATES_MODE ?? 'none') as UpdatesMode;
  if (!['webhook', 'polling', 'none'].includes(mode)) throw new Error(`MAX_UPDATES_MODE: недопустимое значение «${mode}»`);
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8080}`).replace(/\/+$/, '');
  const botToken = env.MAX_BOT_TOKEN?.trim() || null;
  if (mode !== 'none' && !botToken) throw new Error('MAX_BOT_TOKEN обязателен для MAX_UPDATES_MODE=webhook|polling');
  if (mode === 'webhook' && !publicUrl.startsWith('https://')) throw new Error('MAX_UPDATES_MODE=webhook требует PUBLIC_URL по https:// (порт 443)');
  const sessionSecret = env.SESSION_SECRET?.trim() || '';
  const weakSecret = !sessionSecret || sessionSecret.length < 16 || /change-me/i.test(sessionSecret);
  if (mode !== 'none' && weakSecret) throw new Error('SESSION_SECRET обязателен в режимах webhook/polling: случайная строка не короче 16 символов (например, openssl rand -hex 32)');
  if (mode === 'webhook' && !env.MAX_WEBHOOK_SECRET?.trim()) throw new Error('MAX_WEBHOOK_SECRET обязателен в режиме webhook');
  return {
    botToken,
    webhookSecret: env.MAX_WEBHOOK_SECRET?.trim() || null,
    updatesMode: mode,
    publicUrl,
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? (env.DATA_DIR === '/data' ? '0.0.0.0' : '127.0.0.1'),
    dataDir: resolve(env.DATA_DIR ?? './data'),
    // Без секрета (только режим none, локальные запуски) — случайный на время процесса: сессии живут до перезапуска, но подделать их нельзя.
    sessionSecret: weakSecret ? randomBytes(32).toString('hex') : sessionSecret,
    apiBase: env.MAX_API_BASE?.trim() || 'https://platform-api2.max.ru',
    logLevel: env.LOG_LEVEL ?? 'info',
    packsDir: resolve(env.PACKS_DIR ?? resolve(import.meta.dirname, '../../packs')),
    vacancyCacheHours: Number(env.VACANCY_CACHE_HOURS ?? 6),
    profileCacheHours: Number(env.PROFILE_CACHE_HOURS ?? 24 * 30),
    maxVacancyRecords: Number(env.MAX_VACANCY_RECORDS ?? 2000),
    maxEmployersToEnrich: Number(env.MAX_EMPLOYERS_TO_ENRICH ?? 60),
    inspectionsYear: Number(env.ERKNM_YEAR ?? new Date().getFullYear()),
    inspectionsMaxAgeDays: Number(env.ERKNM_MAX_AGE_DAYS ?? 7),
  };
}
