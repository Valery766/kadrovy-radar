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
  /**
   * Чьим заголовкам X-Forwarded-For верить при определении IP клиента (лимиты демо-режима):
   * список адресов/CIDR через запятую, true – всем (небезопасно без прокси), false – никому.
   * По умолчанию только loopback: nginx на том же хосте.
   */
  trustProxy: string | boolean;
}

/**
 * Пустая строка – это «не задано», а не значение: `.env`, собранный из `.env.example`,
 * приносит в контейнер `ERKNM_YEAR=`, `HOST=` и т. п., и `Number('')` дал бы 0, а `resolve('')` – cwd.
 */
function str(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

/** Число из переменной окружения; пустая строка и мусор дают значение по умолчанию. */
function num(value: string | undefined, fallback: number): number {
  const v = str(value);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (str(env.MAX_UPDATES_MODE) ?? 'none') as UpdatesMode;
  if (!['webhook', 'polling', 'none'].includes(mode)) throw new Error(`MAX_UPDATES_MODE: недопустимое значение «${mode}»`);
  const publicUrl = (str(env.PUBLIC_URL) ?? `http://localhost:${num(env.PORT, 8080)}`).replace(/\/+$/, '');
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
    port: num(env.PORT, 8080),
    host: str(env.HOST) ?? (str(env.DATA_DIR) === '/data' ? '0.0.0.0' : '127.0.0.1'),
    dataDir: resolve(str(env.DATA_DIR) ?? './data'),
    // Без секрета (только режим none, локальные запуски) – случайный на время процесса: сессии живут до перезапуска, но подделать их нельзя.
    sessionSecret: weakSecret ? randomBytes(32).toString('hex') : sessionSecret,
    apiBase: str(env.MAX_API_BASE) ?? 'https://platform-api2.max.ru',
    logLevel: str(env.LOG_LEVEL) ?? 'info',
    packsDir: resolve(str(env.PACKS_DIR) ?? resolve(import.meta.dirname, '../../packs')),
    vacancyCacheHours: num(env.VACANCY_CACHE_HOURS, 6),
    profileCacheHours: num(env.PROFILE_CACHE_HOURS, 24 * 30),
    maxVacancyRecords: num(env.MAX_VACANCY_RECORDS, 2000),
    maxEmployersToEnrich: num(env.MAX_EMPLOYERS_TO_ENRICH, 60),
    inspectionsYear: num(env.ERKNM_YEAR, new Date().getFullYear()),
    inspectionsMaxAgeDays: num(env.ERKNM_MAX_AGE_DAYS, 7),
    trustProxy: trustProxyOf(str(env.TRUST_PROXY)),
  };
}

/** «true»/«false» → булево, иначе список адресов; пусто – только loopback. */
function trustProxyOf(value: string | undefined): string | boolean {
  if (value === undefined) return '127.0.0.1,::1';
  if (/^(true|1|yes)$/i.test(value)) return true;
  if (/^(false|0|no)$/i.test(value)) return false;
  return value;
}
