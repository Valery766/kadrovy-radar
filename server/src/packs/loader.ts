/**
 * Загрузчик пакетов контекста (переменная часть). Ядро получает готовый объект Pack
 * и не знает, откуда он взялся. Здесь же — выбор пакета по профилю бизнеса.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Pack, PhraseRule, Profession } from '../core/types.js';
import { normalizeText } from '../core/text.js';

const professionSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  title: z.string().min(1),
  query: z.string().min(1),
  synonyms: z.array(z.string().min(1)).min(1),
  exclude: z.array(z.string().min(1)).default([]),
});

const phraseSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  patterns: z.array(z.string().min(1)).min(1),
});

const thresholdsSchema = z.object({
  minEmployers: z.number().int().min(1),
  minVacancies: z.number().int().min(1),
  salaryMin: z.number().int().min(0),
  salaryMax: z.number().int().min(1),
  perEmployerCap: z.number().int().min(1),
});

const packFileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  version: z.number().int().min(1),
  region: z.object({ fnsCode: z.string().regex(/^\d{2}$/), name: z.string().min(1) }).nullable(),
  industry: z.object({ okvedPrefixes: z.array(z.string().min(2)).min(1), title: z.string().min(1) }).nullable(),
  /** Ключи из каталога или полные описания профессий. */
  professions: z.array(z.union([z.string(), professionSchema])).min(1),
  thresholds: thresholdsSchema,
  vacancyTemplate: z.object({ conditions: z.array(z.string().min(1)).min(1) }),
  demo: z.object({ inn: z.string().min(1), profession: z.string().min(1), salary: z.number().int().min(1), note: z.string().optional() }).nullable(),
});

export interface RegionInfo {
  code: string;
  fnsCode: string;
  name: string;
  avgSalary: number | null;
  unemployment: number | null;
}

/** Позиция справочника ОКПДТР «Работы России» (общероссийский классификатор профессий). */
export interface OkpdtrEntry {
  /** Код ОКПДТР, например «192056». */
  code: string;
  name: string;
}

export interface PackCatalog {
  packs: Pack[];
  regions: RegionInfo[];
  professions: Profession[];
  phrases: PhraseRule[];
  /** Полный справочник ОКПДТР для подсказок по свободному вводу (локальный файл, без запросов в рантайме). */
  okpdtr: OkpdtrEntry[];
}

export class PackValidationError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'PackValidationError';
  }
}

function readYaml(path: string): unknown {
  return parse(readFileSync(path, 'utf8'));
}

/** Очищает название региона от канцелярита справочника: «г Санкт-Петербург» → «Санкт-Петербург». */
export function prettyRegionName(name: string): string {
  return name.replace(/^г\s+/i, '').replace(/^(.*)\s+республика$/i, 'Республика $1').replace(/^(.*)\s+(край|область|автономный округ|автономная область)$/i, '$1 $2').trim();
}

export function loadCatalog(dir: string): PackCatalog {
  const sharedDir = join(dir, '_shared');
  const professionsRaw = z.object({ professions: z.array(professionSchema) }).parse(readYaml(join(sharedDir, 'professions.yaml')));
  const phrasesRaw = z.object({ phrases: z.array(phraseSchema) }).parse(readYaml(join(sharedDir, 'phrases.yaml')));
  const regionsRaw = JSON.parse(readFileSync(join(sharedDir, 'regions.json'), 'utf8')) as { regions: RegionInfo[] };
  const regions = regionsRaw.regions.map((r) => ({ ...r, name: prettyRegionName(r.name) }));
  const catalog = new Map(professionsRaw.professions.map((p) => [p.key, p]));
  for (const rule of phrasesRaw.phrases) {
    for (const p of rule.patterns) {
      try { new RegExp(p, 'i'); } catch (e) { throw new PackValidationError('_shared/phrases.yaml', `невалидное выражение «${p}» у ${rule.key}: ${(e as Error).message}`); }
    }
  }

  const packs: Pack[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') && !f.startsWith('.')).sort();
  for (const file of files) {
    const parsed = packFileSchema.safeParse(readYaml(join(dir, file)));
    if (!parsed.success) throw new PackValidationError(file, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const p = parsed.data;
    const professions: Profession[] = p.professions.map((entry) => {
      if (typeof entry === 'string') {
        const found = catalog.get(entry);
        if (!found) throw new PackValidationError(file, `профессия «${entry}» не найдена в _shared/professions.yaml`);
        return found;
      }
      return { ...entry, exclude: entry.exclude ?? [] };
    });
    if (p.thresholds.salaryMin >= p.thresholds.salaryMax) throw new PackValidationError(file, 'thresholds.salaryMin должен быть меньше salaryMax');
    if (p.region && !regions.some((r) => r.fnsCode === p.region!.fnsCode)) throw new PackValidationError(file, `регион с кодом ФНС ${p.region.fnsCode} не найден в _shared/regions.json`);
    if (p.demo && !professions.some((x) => x.key === p.demo!.profession)) throw new PackValidationError(file, `demo.profession «${p.demo.profession}» отсутствует в пакете`);
    packs.push({
      id: p.id, title: p.title, version: p.version, region: p.region, industry: p.industry,
      professions, thresholds: p.thresholds, requirementPhrases: phrasesRaw.phrases,
      vacancyTemplate: p.vacancyTemplate, demo: p.demo,
    });
  }
  if (!packs.some((p) => p.region === null)) throw new PackValidationError(dir, 'нужен универсальный пакет (region: null)');
  return { packs, regions, professions: professionsRaw.professions, phrases: phrasesRaw.phrases, okpdtr: loadOkpdtr(sharedDir) };
}

/** Справочник ОКПДТР: локальная копия https://opendata.trudvsem.ru/json/profession.json (только активные записи). */
function loadOkpdtr(sharedDir: string): OkpdtrEntry[] {
  const path = join(sharedDir, 'okpdtr.json');
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { professions?: OkpdtrEntry[] };
  return (raw.professions ?? []).filter((p) => p && typeof p.code === 'string' && typeof p.name === 'string');
}

export interface ProfileHint {
  fnsRegionCode: string | null;
  okved: string | null;
}

/** Выбор пакета: регион+отрасль → регион → универсальный. */
export function selectPack(catalog: PackCatalog, hint: ProfileHint): Pack {
  const { fnsRegionCode, okved } = hint;
  const byRegion = catalog.packs.filter((p) => p.region && fnsRegionCode && p.region.fnsCode === fnsRegionCode);
  const exact = byRegion.find((p) => p.industry && okved && p.industry.okvedPrefixes.some((pre) => okved.startsWith(pre)));
  if (exact) return exact;
  const regionOnly = byRegion.find((p) => p.industry === null) ?? byRegion[0];
  if (regionOnly) return regionOnly;
  return catalog.packs.find((p) => p.region === null)!;
}

/** Код региона «Работы России» по коду ФНС: «78» → «7800000000000». */
export function regionByFnsCode(catalog: PackCatalog, fnsCode: string | null): RegionInfo | null {
  if (!fnsCode) return null;
  return catalog.regions.find((r) => r.fnsCode === fnsCode) ?? null;
}

/* ───────────────────── Свободный ввод профессии ───────────────────── */

/** Префикс ключа профессии, которой нет в каталоге: «custom:<slug>». */
export const CUSTOM_PROFESSION_PREFIX = 'custom:';

export const isCustomProfessionKey = (key: string): boolean => key.startsWith(CUSTOM_PROFESSION_PREFIX);

/**
 * Устойчивый slug для произвольного текста: латиница, цифры и дефис.
 * Транслитерация не нужна и вредна (она неоднозначна), поэтому берём короткий хеш
 * нормализованного текста: один и тот же запрос всегда даёт один и тот же ключ,
 * а ключ безопасен для URL, callback-payload бота и колонок БД.
 */
export function professionSlug(text: string): string {
  const normalized = normalizeText(text);
  const hash = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
  const latin = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return latin ? `${latin}-${hash}` : hash;
}

/** Первая буква заглавная, остальной текст не трогаем («старший пекарь» → «Старший пекарь»). */
function capitalize(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Профессия из каталога по точному совпадению названия или синонима, затем по вхождению. */
function findInCatalog(pool: Profession[], text: string): Profession | null {
  const t = normalizeText(text);
  if (!t) return null;
  return pool.find((p) => normalizeText(p.title) === t || p.synonyms.some((s) => normalizeText(s) === t))
    ?? pool.find((p) => p.synonyms.some((s) => t.includes(normalizeText(s))) && !p.exclude.some((e) => t.includes(normalizeText(e))))
    ?? null;
}

/** Профессии пакета, затем остальной каталог — приоритет у отраслевого набора. */
export function professionPool(catalog: PackCatalog, pack: Pack | null): Profession[] {
  const packList = pack?.professions ?? [];
  return [...packList, ...catalog.professions.filter((p) => !packList.some((x) => x.key === p.key))];
}

/**
 * Свободный ввод должности: сначала пытаемся узнать профессию пакета или каталога,
 * иначе собираем «свою» профессию, с которой ядро работает точно так же.
 * Ключ детерминирован: повтор того же текста даёт тот же ключ (кэш и подписки не дублируются).
 */
export function resolveProfession(catalog: PackCatalog, pack: Pack | null, text: string): Profession | null {
  const raw = text.trim().replace(/\s+/g, ' ');
  if (!raw) return null;
  const known = findInCatalog(professionPool(catalog, pack), raw);
  if (known) return known;
  return {
    key: `${CUSTOM_PROFESSION_PREFIX}${professionSlug(raw)}`,
    title: capitalize(raw),
    query: raw,
    synonyms: [raw],
    exclude: [],
  };
}

export interface ProfessionSuggestion {
  /** Ключ каталога или «custom:<slug>» для позиции ОКПДТР. */
  key: string;
  title: string;
  /** Откуда подсказка: отобранный каталог пакетов или справочник ОКПДТР. */
  source: 'catalog' | 'okpdtr';
  /** Код ОКПДТР, если подсказка из справочника. */
  code?: string;
}

/**
 * Подсказки по подстроке для мини-приложения и бота: сначала профессии каталога,
 * затем позиции ОКПДТР. Работает офлайн по локальному справочнику, без запросов к источникам.
 */
export function suggestProfessions(catalog: PackCatalog, text: string, limit = 10): ProfessionSuggestion[] {
  const q = normalizeText(text);
  if (q.length < 2) return [];
  const rank = (name: string): number => {
    const n = normalizeText(name);
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (new RegExp(`(^|[\\s(-])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(n)) return 2;
    return n.includes(q) ? 3 : -1;
  };
  type Scored = ProfessionSuggestion & { score: number; length: number };
  const scored: Scored[] = [];
  for (const p of catalog.professions) {
    const r = Math.min(...[p.title, ...p.synonyms].map(rank).filter((x) => x >= 0), Number.POSITIVE_INFINITY);
    if (Number.isFinite(r)) scored.push({ key: p.key, title: p.title, source: 'catalog', score: r, length: p.title.length });
  }
  const taken = new Set(scored.map((s) => normalizeText(s.title)));
  for (const e of catalog.okpdtr) {
    const r = rank(e.name);
    if (r < 0 || taken.has(normalizeText(e.name))) continue;
    scored.push({ key: `${CUSTOM_PROFESSION_PREFIX}${professionSlug(e.name)}`, title: e.name, source: 'okpdtr', code: e.code, score: r + 4, length: e.name.length });
  }
  scored.sort((a, b) => a.score - b.score || a.length - b.length || a.title.localeCompare(b.title, 'ru'));
  return scored.slice(0, Math.max(1, limit)).map(({ score: _score, length: _length, ...rest }) => rest);
}
