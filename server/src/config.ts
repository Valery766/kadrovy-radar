/** Конфигурация из переменных окружения. Секреты никогда не логируются. */
import { resolve } from 'node:path';

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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.MAX_UPDATES_MODE ?? 'none') as UpdatesMode;
  if (!['webhook', 'polling', 'none'].includes(mode)) throw new Error(`MAX_UPDATES_MODE: недопустимое значение «${mode}»`);
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8080}`).replace(/\/+$/, '');
  const botToken = env.MAX_BOT_TOKEN?.trim() || null;
  if (mode !== 'none' && !botToken) throw new Error('MAX_BOT_TOKEN обязателен для MAX_UPDATES_MODE=webhook|polling');
  if (mode === 'webhook' && !publicUrl.startsWith('https://')) throw new Error('MAX_UPDATES_MODE=webhook требует PUBLIC_URL по https:// (порт 443)');
  return {
    botToken,
    webhookSecret: env.MAX_WEBHOOK_SECRET?.trim() || null,
    updatesMode: mode,
    publicUrl,
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    dataDir: resolve(env.DATA_DIR ?? './data'),
    sessionSecret: env.SESSION_SECRET?.trim() || 'dev-session-secret-change-me',
    apiBase: env.MAX_API_BASE?.trim() || 'https://platform-api2.max.ru',
    logLevel: env.LOG_LEVEL ?? 'info',
    packsDir: resolve(env.PACKS_DIR ?? resolve(import.meta.dirname, '../../packs')),
    vacancyCacheHours: Number(env.VACANCY_CACHE_HOURS ?? 6),
    profileCacheHours: Number(env.PROFILE_CACHE_HOURS ?? 24 * 30),
    maxVacancyRecords: Number(env.MAX_VACANCY_RECORDS ?? 2000),
    maxEmployersToEnrich: Number(env.MAX_EMPLOYERS_TO_ENRICH ?? 60),
  };
}
