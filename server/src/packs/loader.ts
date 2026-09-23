/**
 * Загрузчик пакетов контекста (переменная часть). Ядро получает готовый объект Pack
 * и не знает, откуда он взялся. Здесь же — выбор пакета по профилю бизнеса.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Pack, PhraseRule, Profession } from '../core/types.js';

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

export interface PackCatalog {
  packs: Pack[];
  regions: RegionInfo[];
  professions: Profession[];
  phrases: PhraseRule[];
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
  return { packs, regions, professions: professionsRaw.professions, phrases: phrasesRaw.phrases };
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
