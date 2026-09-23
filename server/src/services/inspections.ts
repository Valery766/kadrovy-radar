/**
 * Плановые проверки на год из ЕРКНМ (Генпрокуратура): загрузка набора в SQLite и ответ бизнесу.
 * Никаких оценок «вероятности проверки» — только факты плана (даты, вид надзора, орган)
 * и счётчики по региону и разделу ОКВЭД.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db, InspectionDatasetRow, InspectionKindKey, InspectionRow } from '../db/index.js';
import { beginInspectionsLoad, getInspectionDataset, inspectionCounts, inspectionsByInn, touchInspectionDataset } from '../db/index.js';
import { erknm, SOURCES, SourceError } from '../integrations/index.js';
import type { RegionRef } from '../integrations/erknm.js';
import { pluralRu } from '../core/index.js';
import type { SourceBadge } from './market.js';
import type { Config } from '../config.js';
import type { PackCatalog, RegionInfo } from '../packs/loader.js';
import { regionByFnsCode } from '../packs/loader.js';

export interface InspectionsContext {
  db: Db;
  config: Config;
  catalog: PackCatalog;
  log: { info: (o: object, msg?: string) => void; warn: (o: object, msg?: string) => void };
}

export const KIND_LABEL = erknm.KIND_LABEL;

/* ---------- загрузка набора ---------- */

const datasetDir = (config: Config) => join(config.dataDir, 'erknm');

/** Идёт ли уже загрузка: параллельно два раза распаковывать 480 МБ смысла нет. */
let syncing = false;

export interface SyncResult {
  status: 'loaded' | 'up_to_date' | 'busy';
  dataset: InspectionDatasetRow | null;
}

/**
 * Проверяет паспорт набора за год и, если версия новее сохранённой, скачивает архив,
 * разбирает его и перезаливает таблицу одной транзакцией. Ошибки сети пробрасываются наверх:
 * вызывающая сторона (планировщик) их логирует, а сервис продолжает отвечать по старым данным.
 */
export async function syncInspections(ctx: InspectionsContext, opts: { force?: boolean } = {}): Promise<SyncResult> {
  const year = ctx.config.inspectionsYear;
  if (syncing) return { status: 'busy', dataset: getInspectionDataset(ctx.db, year) };
  syncing = true;
  try {
    const current = getInspectionDataset(ctx.db, year);
    const dir = datasetDir(ctx.config);
    let passport: erknm.DatasetPassport;
    try {
      passport = await erknm.fetchPassport(year);
    } catch (err) {
      // Источник недоступен (например, отдаёт 502), но архив уже лежит в DATA_DIR — разбираем его, чтобы сервис не зависел от сайта.
      const local = await newestArchive(dir);
      if (!local || (current && current.fileName === local)) throw err;
      ctx.log.warn({ err: describeSyncError(err), file: local }, 'erknm: источник недоступен, разбираю архив с диска');
      passport = {
        year, datasetId: `7710146102-plan-${year}`, datasetName: `Планы проверок на ${year} год`,
        owner: 'Генеральная прокуратура Российской Федерации', fileName: local, fileUrl: '',
        version: erknm.versionFromFileName(local) ?? 'local', xsdUrl: null, fetchedAt: new Date().toISOString(),
      };
    }
    if (!opts.force && current && current.fileName === passport.fileName) {
      // Версия та же: отмечаем проверку, иначе набор навсегда останется «просроченным» и мы будем ходить к источнику каждый час.
      touchInspectionDataset(ctx.db, year);
      ctx.log.info({ year, version: current.version, records: current.records }, 'erknm: набор уже актуален');
      return { status: 'up_to_date', dataset: getInspectionDataset(ctx.db, year) ?? current };
    }
    const zipPath = join(dir, passport.fileName);
    // Архив нужной версии уже лежит в DATA_DIR (перезапуск после обрыва разбора) — качать заново не нужно.
    const onDisk = await stat(zipPath).then((s) => s.size, () => 0);
    if (onDisk > 0) {
      ctx.log.info({ year, file: passport.fileName, bytes: onDisk }, 'erknm: архив уже скачан, разбираю');
    } else {
      ctx.log.info({ year, version: passport.version, file: passport.fileName }, 'erknm: скачиваю архив плана проверок');
      await erknm.downloadDataset(passport.fileUrl, zipPath);
    }

    const aliases = erknm.buildRegionAliases(ctx.catalog.regions);
    const loader = beginInspectionsLoad(ctx.db, year);
    let lastLogged = 0;
    let dataset: InspectionDatasetRow;
    try {
      for await (const rec of erknm.readDataset(zipPath, (files, records) => {
        if (files - lastLogged >= 200) { lastLogged = files; ctx.log.info({ files, records }, 'erknm: разбор архива'); }
      })) {
        const region = pickRegion(aliases, rec.addresses);
        loader.add({
          id: `${rec.erpId}-${rec.subjectIndex}`,
          year,
          erpId: rec.erpId,
          inn: rec.inn,
          ogrn: rec.ogrn,
          subjectName: rec.subjectName,
          subjectType: rec.subjectType,
          mspCode: rec.mspCode,
          okved: rec.okved,
          okved2: rec.okved2,
          kind: rec.kind,
          kindControl: rec.kindControl,
          kindKnm: rec.kindKnm,
          typeName: rec.typeName,
          status: rec.status,
          startDate: rec.startDate,
          stopDate: rec.stopDate,
          organization: rec.organization,
          prosecutorOffice: rec.prosecutorOffice,
          address: region?.address ?? rec.addresses[0] ?? null,
          regionCode: region?.region.code ?? null,
          regionFnsCode: region?.region.fnsCode ?? null,
        });
      }
      dataset = loader.commit({ year, datasetId: passport.datasetId, version: passport.version, fileName: passport.fileName });
    } catch (err) {
      loader.abort();
      throw err;
    }
    ctx.log.info({ year, version: dataset.version, records: dataset.records, withRegion: dataset.withRegion }, 'erknm: набор загружен');
    await dropOldArchives(dir, passport.fileName, ctx);
    return { status: 'loaded', dataset };
  } finally {
    syncing = false;
  }
}

/** Первый адрес записи, по которому регион определился; если ни один — null (не угадываем). */
function pickRegion(aliases: ReturnType<typeof erknm.buildRegionAliases>, addresses: readonly string[]): { region: RegionRef; address: string } | null {
  for (const address of addresses) {
    const region = erknm.regionFromAddress(aliases, address);
    if (region) return { region, address };
  }
  return null;
}

/** Самый свежий архив плана в DATA_DIR/erknm (по дате в имени) — для разбора без доступа к источнику. */
async function newestArchive(dir: string): Promise<string | null> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const zips = names.filter((n) => /^data-\d{8}-structure-\d{8}\.zip$/.test(n)).sort();
  return zips.at(-1) ?? null;
}

async function dropOldArchives(dir: string, keep: string, ctx: InspectionsContext): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (name === keep || !name.endsWith('.zip')) continue;
      await rm(join(dir, name), { force: true });
    }
  } catch (err) { ctx.log.warn({ err: String(err) }, 'erknm: не удалось удалить старые архивы'); }
}

/** Загружен ли план проверок: без него региональный контекст считать не из чего. */
export function inspectionsLoaded(ctx: InspectionsContext): boolean {
  return getInspectionDataset(ctx.db, ctx.config.inspectionsYear) !== null;
}

/** Нужна ли проверка источника: набора нет или его последний раз подтверждали больше ERKNM_MAX_AGE_DAYS назад. */
export function needsSync(ctx: InspectionsContext): boolean {
  const current = getInspectionDataset(ctx.db, ctx.config.inspectionsYear);
  if (!current) return true;
  return Date.now() - Date.parse(current.loadedAt) > ctx.config.inspectionsMaxAgeDays * 86400_000;
}

/* ---------- ответ бизнесу ---------- */

export interface InspectionView {
  erpId: string;
  /** Формулировка вида надзора из реестра, как есть. */
  kindControl: string | null;
  kind: InspectionKindKey;
  kindLabel: string;
  /** Вид мероприятия: «Выездная проверка», «Документарная проверка», … */
  kindKnm: string | null;
  startDate: string | null;
  stopDate: string | null;
  status: string | null;
  organization: string | null;
  prosecutorOffice: string | null;
  address: string | null;
  regionName: string | null;
  subjectName: string | null;
  mspCode: string | null;
}

export interface InspectionsContextBlock {
  region: { fnsCode: string; code: string; name: string } | null;
  okved2: string | null;
  /** По чему посчитаны счётчики: регион + раздел ОКВЭД, только регион или ничего. */
  scope: 'region_okved' | 'region' | 'none';
  byKind: Record<InspectionKindKey, number>;
  total: number;
}

export interface InspectionsResult {
  /** false — набор ещё не загружен (первый запуск или источник был недоступен). */
  loaded: boolean;
  inn: string | null;
  own: InspectionView[];
  context: InspectionsContextBlock;
  dataset: { year: number; version: string; records: number; withRegion: number; loadedAt: string } | null;
  sources: SourceBadge[];
}

const EMPTY_KINDS: Record<InspectionKindKey, number> = { labor: 0, sanitary: 0, fire: 0, other: 0 };

export interface InspectionsRequest {
  inn?: string | null;
  /** Код ФНС региона («78») — приоритетнее кода «Работы России». */
  regionFnsCode?: string | null;
  /** Код региона «Работы России» (13 знаков). */
  regionCode?: string | null;
  /** ОКВЭД бизнеса: для контекста берём раздел (первые две цифры). */
  okved?: string | null;
}

/**
 * Плановые КНМ по ИНН бизнеса и контекст «сколько проверок в моём регионе по моей отрасли».
 * Набора нет — возвращаем loaded: false с пустыми списками, а не ошибку: источник обновляется фоном.
 */
export function inspectionsForBusiness(ctx: InspectionsContext, req: InspectionsRequest): InspectionsResult {
  const year = ctx.config.inspectionsYear;
  const dataset = getInspectionDataset(ctx.db, year);
  const region = resolveRegion(ctx.catalog, req);
  const okved2 = req.okved ? (/^(\d{2})/.exec(req.okved)?.[1] ?? null) : null;
  const inn = req.inn ? req.inn.replace(/\D/g, '') : null;
  if (!dataset) {
    return {
      loaded: false, inn, own: [],
      context: { region: region ? regionRef(region) : null, okved2, scope: 'none', byKind: { ...EMPTY_KINDS }, total: 0 },
      dataset: null,
      sources: [{ ...SOURCES.erknm, fetchedAt: new Date().toISOString(), note: 'план проверок ещё не загружен' }],
    };
  }
  const own = inn ? inspectionsByInn(ctx.db, inn, year).map((r) => toView(ctx.catalog, r)) : [];
  const scope: InspectionsContextBlock['scope'] = region && okved2 ? 'region_okved' : region ? 'region' : 'none';
  const counts = region ? inspectionCounts(ctx.db, year, { regionCode: region.code, okved2 }) : { byKind: { ...EMPTY_KINDS }, total: 0 };
  return {
    loaded: true,
    inn,
    own,
    context: { region: region ? regionRef(region) : null, okved2, scope, byKind: counts.byKind, total: counts.total },
    dataset: { year: dataset.year, version: dataset.version, records: dataset.records, withRegion: dataset.withRegion, loadedAt: dataset.loadedAt },
    sources: [{ ...SOURCES.erknm, fetchedAt: dataset.loadedAt, note: `план на ${year} год, версия от ${dataset.version}, ${dataset.records} записей` }],
  };
}

const regionRef = (r: RegionInfo) => ({ fnsCode: r.fnsCode, code: r.code, name: r.name });

function resolveRegion(catalog: PackCatalog, req: InspectionsRequest): RegionInfo | null {
  if (req.regionFnsCode) return regionByFnsCode(catalog, req.regionFnsCode);
  if (req.regionCode) return catalog.regions.find((r) => r.code === req.regionCode) ?? null;
  return null;
}

function toView(catalog: PackCatalog, r: InspectionRow): InspectionView {
  return {
    erpId: r.erpId,
    kindControl: r.kindControl,
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind],
    kindKnm: r.kindKnm,
    startDate: r.startDate,
    stopDate: r.stopDate,
    status: r.status,
    organization: r.organization,
    prosecutorOffice: r.prosecutorOffice,
    address: r.address,
    regionName: catalog.regions.find((x) => x.code === r.regionCode)?.name ?? null,
    subjectName: r.subjectName,
    mspCode: r.mspCode,
  };
}

/* ---------- текст для чата ---------- */

/** «2026-03-16» → «16.03.2026»; пусто — прочерк. */
export const fmtPlanDate = (iso: string | null): string => {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '—';
};

/** Лимит MAX на одно сообщение: в него должен уместиться весь блок «Проверки». */
const MAX_TEXT_LENGTH = 4000;
/** Сколько символов резервируем под контекст региона и строку источника. */
const TAIL_BUDGET = 800;

/** Детерминированный текст блока «Проверки {год}» для чата: только факты плана и счётчики. */
export function inspectionsText(r: InspectionsResult): string {
  if (!r.loaded) {
    return 'Проверки: план ЕРКНМ ещё не загружен — набор Генпрокуратуры обновляется в фоне, обычно это несколько минут после запуска. Загляните чуть позже.';
  }
  const year = r.dataset!.year;
  const lines: string[] = [`🛡 Проверки ${year}`];
  if (!r.inn) {
    lines.push('ИНН не указан — назовите его командой /profile, и я посмотрю ваш бизнес в плане.');
  } else if (r.own.length === 0) {
    lines.push(`По ИНН ${r.inn} плановых проверок в плане ${year} года нет.`);
  } else {
    lines.push(`По ИНН ${r.inn} в плане проверок ${year}: ${r.own.length}.`);
    // Формулировки реестра длинные, а сообщение одно: добавляем КНМ, пока хватает места.
    let used = lines[0]!.length + lines[1]!.length;
    let shown = 0;
    for (const x of r.own) {
      const block = [
        `• ${x.startDate ? `${fmtPlanDate(x.startDate)}—${fmtPlanDate(x.stopDate)}` : 'даты не указаны'}: ${x.kindControl ?? x.kindLabel}${x.kindKnm ? ` (${x.kindKnm})` : ''}`,
        x.organization ? `  Орган: ${x.organization}` : null,
        x.address ? `  Объект: ${x.address}` : null,
        x.status ? `  Статус в реестре: ${x.status}` : null,
      ].filter((l): l is string => l !== null);
      const size = block.reduce((n, l) => n + l.length + 1, 0);
      if (shown > 0 && used + size > MAX_TEXT_LENGTH - TAIL_BUDGET) break;
      lines.push(...block);
      used += size;
      shown += 1;
    }
    if (shown < r.own.length) lines.push(`…и ещё ${r.own.length - shown} — весь список в мини-приложении.`);
  }
  lines.push('');
  const c = r.context;
  if (c.scope === 'none') {
    lines.push('Контекст по региону покажу, когда буду знать ваш регион: укажите ИНН через /profile.');
  } else {
    const where = c.scope === 'region_okved' ? `в регионе «${c.region!.name}» по ОКВЭД ${c.okved2}` : `в регионе «${c.region!.name}»`;
    lines.push(`Всего ${where} запланировано на ${year} год: ${c.total} ${pluralRu(c.total, 'проверка', 'проверки', 'проверок')} — ${KIND_LABEL.labor} ${c.byKind.labor}, ${KIND_LABEL.sanitary} ${c.byKind.sanitary}, ${KIND_LABEL.fire} ${c.byKind.fire}, прочий надзор ${c.byKind.other}.`);
  }
  lines.push('');
  lines.push(`Источник: Единый реестр контрольных (надзорных) мероприятий (Генпрокуратура), план на ${year} год, версия набора от ${fmtPlanDate(r.dataset!.version)}; загружено ${r.dataset!.records} записей, регион определён у ${r.dataset!.withRegion}.`);
  return lines.join('\n');
}

/** Одна строка для карточки профиля: «Проверки 2026: есть N плановых» либо «нет». */
export function inspectionsProfileLine(r: InspectionsResult): string | null {
  if (!r.loaded || !r.inn) return null;
  const year = r.dataset!.year;
  return r.own.length > 0
    ? `Проверки ${year}: ${r.own.length} ${pluralRu(r.own.length, 'проверка', 'проверки', 'проверок')} в плане — подробности по команде /checks`
    : `Проверки ${year}: плановых по вашему ИНН нет — контекст по региону покажет /checks`;
}

/** Ошибка источника ЕРКНМ для логов планировщика. */
export const describeSyncError = (err: unknown): string => (err instanceof SourceError ? err.message : String((err as Error)?.message ?? err));
