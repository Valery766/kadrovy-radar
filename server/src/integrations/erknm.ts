/**
 * Драйвер Единого реестра контрольных (надзорных) мероприятий (ЕРКНМ, Генеральная прокуратура).
 * Открытые данные без ключей и без входа, проверено 23.09.2026:
 *  - паспорт набора за год: GET /public/api/opendata/plans/{год}?isFederalLaw248=true → JSON
 *    с datasetPassport, ссылкой на ZIP (dataZipUrl) и XSD; список наборов — /public/api/opendata/list;
 *  - ZIP на 2026 год — 38,8 МБ, 809 XML, 29 644 плановых КНМ и 29 832 субъекта;
 *  - в ссылках паспорта встречается двойной слэш («…gov.ru//blob/…») — нормализуем;
 *  - интерактивный поиск на сайте закрыт CAPTCHA и здесь не используется.
 * Разбор идёт по одному файлу архива за раз: распаковывать 481 МБ целиком в память не нужно.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { XMLParser } from 'fast-xml-parser';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';
import { fetchJson, SourceError } from './http.js';

export const ERKNM_BASE = 'https://proverki.gov.ru';
export const SOURCE_ID = 'erknm';
export const SOURCE_TITLE = 'Единый реестр контрольных (надзорных) мероприятий (Генпрокуратура)';

/** Сайт отдаёт 400 на часть клиентов с нестандартным User-Agent — представляемся браузерным. */
const USER_AGENT = 'Mozilla/5.0 (compatible; stavka-max/0.1; +hackathon MAX)';

/* ---------- паспорт набора ---------- */

interface RawPassport {
  datasetPassport?: { datasetId?: string; datasetName?: string; datasetOwner?: string; dataFormat?: string };
  dataZipName?: string;
  dataZipUrl?: string;
  structureXsdName?: string;
  structureXsdUrl?: string;
  history?: { published?: string; fileName?: string; fileUrl?: string }[];
}

export interface DatasetPassport {
  year: number;
  datasetId: string;
  datasetName: string;
  owner: string;
  /** Имя файла архива: «data-20260923-structure-20220115.zip». */
  fileName: string;
  fileUrl: string;
  /** Версия набора — дата из имени файла, «2026-09-23». */
  version: string;
  xsdUrl: string | null;
  fetchedAt: string;
}

/** «https://proverki.gov.ru//blob/erknm-plan/2026/x.zip» → без двойного слэша в пути. */
export function normalizeUrl(url: string): string {
  return url.replace(/([^:])\/{2,}/g, '$1/');
}

/** Дата версии из имени архива: «data-20260923-structure-20220115.zip» → «2026-09-23». */
export function versionFromFileName(fileName: string): string | null {
  const m = /data-(\d{4})(\d{2})(\d{2})-/.exec(fileName);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export async function fetchPassport(year: number, opts: { timeoutMs?: number } = {}): Promise<DatasetPassport> {
  const url = `${ERKNM_BASE}/public/api/opendata/plans/${year}?isFederalLaw248=true`;
  const raw = await fetchJson<RawPassport>(url, { source: SOURCE_ID, timeoutMs: opts.timeoutMs ?? 30_000, retries: 2, headers: { 'user-agent': USER_AGENT } });
  const fileUrl = raw.dataZipUrl ?? raw.history?.[0]?.fileUrl;
  const fileName = raw.dataZipName ?? raw.history?.[0]?.fileName;
  if (!fileUrl || !fileName) throw new SourceError(SOURCE_ID, `в паспорте набора за ${year} год нет ссылки на архив`);
  return {
    year,
    datasetId: raw.datasetPassport?.datasetId ?? `plan-${year}`,
    datasetName: raw.datasetPassport?.datasetName ?? `Планы проверок на ${year} год`,
    owner: raw.datasetPassport?.datasetOwner ?? 'Генеральная прокуратура Российской Федерации',
    fileName,
    fileUrl: normalizeUrl(fileUrl),
    version: versionFromFileName(fileName) ?? raw.history?.[0]?.published ?? new Date().toISOString().slice(0, 10),
    xsdUrl: raw.structureXsdUrl ? normalizeUrl(raw.structureXsdUrl) : null,
    fetchedAt: new Date().toISOString(),
  };
}

/** Скачивает архив во временный файл рядом с целевым и переименовывает — частично скачанный файл не остаётся. */
export async function downloadDataset(url: string, destPath: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.part`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15 * 60_000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/zip,*/*' }, signal: controller.signal });
    if (!res.ok || !res.body) throw new SourceError(SOURCE_ID, `HTTP ${res.status} при скачивании архива`, res.status, res.status >= 500);
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
    await rename(tmp, destPath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    if (err instanceof SourceError) throw err;
    const e = err as Error;
    throw new SourceError(SOURCE_ID, e.name === 'AbortError' ? 'таймаут скачивания архива' : String(e.message ?? e), undefined, true);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- запись плана ---------- */

/** Вид надзора в четырёх группах: трудовая инспекция, санитарный, пожарный, остальное. */
export type InspectionKind = 'labor' | 'sanitary' | 'fire' | 'other';

export const KIND_LABEL: Record<InspectionKind, string> = {
  labor: 'трудовая инспекция',
  sanitary: 'Роспотребнадзор',
  fire: 'пожарный надзор',
  other: 'другой надзор',
};

/**
 * Группа вида надзора по подстроке KIND_CONTROL. Исходная формулировка сохраняется целиком:
 * группа — только способ сложить счётчики, в карточке показываем текст реестра.
 */
export function normalizeKind(kindControl: string | null | undefined): InspectionKind {
  const s = (kindControl ?? '').toLowerCase().replace(/ё/g, 'е');
  if (s.includes('трудового законодательства') || s.includes('трудовому законодательству')) return 'labor';
  if (s.includes('санитарно-эпидемиологич')) return 'sanitary';
  if (s.includes('пожарн')) return 'fire';
  return 'other';
}

export interface InspectionRecord {
  /** Учётный номер КНМ в ЕРКНМ (ERPID) — вместе с номером субъекта даёт устойчивый ключ. */
  erpId: string;
  /** Идентификатор плана (атрибут ID корневого элемента PLAN). */
  planId: string;
  /** Номер субъекта внутри КНМ (1, 2, …): вместе с erpId даёт устойчивый ключ записи. */
  subjectIndex: number;
  year: number;
  status: string | null;
  typeName: string | null;
  /** Формулировка вида надзора из реестра — как есть. */
  kindControl: string | null;
  kind: InspectionKind;
  /** Вид мероприятия: «Выездная проверка», «Документарная проверка», … */
  kindKnm: string | null;
  startDate: string | null;
  stopDate: string | null;
  /** Контрольный (надзорный) орган: «ГОСУДАРСТВЕННАЯ ИНСПЕКЦИЯ ТРУДА В ИРКУТСКОЙ ОБЛАСТИ». */
  organization: string | null;
  prosecutorOffice: string | null;
  inn: string | null;
  ogrn: string | null;
  subjectName: string | null;
  /** «ЮЛ» / «ФЛ» — тип субъекта в реестре. */
  subjectType: string | null;
  /** «Микропредприятие», «Малое предприятие», «Не является субъектом МСП», … */
  mspCode: string | null;
  /** Первый код ОКВЭД субъекта. */
  okved: string | null;
  /** Раздел ОКВЭД (первые две цифры первого кода) — по нему считаем отраслевой контекст. */
  okved2: string | null;
  /**
   * Адреса из записи: сначала ADDRESS объектов контроля, затем PLACE (место проведения КНМ).
   * У одного КНМ их бывает несколько; по ним определяем регион.
   */
  addresses: string[];
}

type Attrs = Record<string, unknown>;
const attr = (node: unknown, name: string): string | null => {
  const v = (node as Attrs | undefined)?.[`@_${name}`];
  return v == null || v === '' ? null : String(v);
};
const asArray = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Что забираем из XML. Остальное (перечни мероприятий, инспекторы, эксперты, проверочные листы,
 * решения) пропускаем на входе парсера: в одном файле архива их до 20 МБ, а продукту они не нужны.
 */
const KEPT_TAGS = new Set(['PLAN', 'INSPECTION', 'PROSECUTOR_OFFICE', 'KIND_CONTROL', 'KIND_KNM', 'SUBJECT', 'OKVEDS', 'OBJECT', 'PLACE', 'KNO_ORGANIZATION']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ['INSPECTION', 'SUBJECT', 'OBJECT', 'OKVEDS', 'PLACE'].includes(name),
  updateTag: (tagName) => (KEPT_TAGS.has(tagName) ? tagName : false),
});

const CLOSE_TAG = '</INSPECTION>';

/**
 * Разбор одного XML-файла архива: PLAN → INSPECTION → по записи на каждый субъект КНМ.
 * Файл режем на блоки <INSPECTION>…</INSPECTION> и разбираем по одному: самый большой файл
 * набора — 20 МБ, и дерево целиком в памяти не помещается на маленьком сервере.
 */
export function parseInspectionsXml(xml: string): InspectionRecord[] {
  const head = /<PLAN\b[^>]*>/.exec(xml);
  if (!head) return [];
  const plan = (parser.parse(`${head[0]}</PLAN>`) as { PLAN?: Attrs }).PLAN ?? {};
  const planId = attr(plan, 'ID') ?? '';
  const year = Number(attr(plan, 'YEAR') ?? 0) || 0;
  const out: InspectionRecord[] = [];
  for (let from = head.index; ;) {
    const start = xml.indexOf('<INSPECTION', from);
    if (start < 0) break;
    const end = xml.indexOf(CLOSE_TAG, start);
    if (end < 0) break;
    from = end + CLOSE_TAG.length;
    const node = (parser.parse(xml.slice(start, from)) as { INSPECTION?: Attrs[] }).INSPECTION?.[0];
    if (node) out.push(...recordsFromInspection(node, planId, year));
  }
  return out;
}

function recordsFromInspection(insp: Attrs, planId: string, year: number): InspectionRecord[] {
  const erpId = attr(insp, 'ERPID');
  if (!erpId) return [];
  const kindControl = attr(insp.KIND_CONTROL, 'VALUE');
  const objects = asArray(insp.OBJECT as Attrs[] | undefined);
  const places = asArray(insp.PLACE as (string | number)[] | undefined).map((p) => String(p).trim());
  const addresses = [...new Set([...objects.map((o) => attr(o, 'ADDRESS')), ...places].filter((a): a is string => !!a))];
  const base = {
    erpId,
    planId,
    year,
    status: attr(insp, 'STATUS'),
    typeName: attr(insp, 'TYPE_NAME'),
    kindControl,
    kind: normalizeKind(kindControl),
    kindKnm: attr(insp.KIND_KNM, 'VALUE'),
    startDate: attr(insp, 'START_DATE'),
    stopDate: attr(insp, 'STOP_DATE'),
    organization: attr(insp.KNO_ORGANIZATION, 'VALUE'),
    prosecutorOffice: attr(insp.PROSECUTOR_OFFICE, 'NAME'),
    addresses,
  };
  const subjects = asArray(insp.SUBJECT as Attrs[] | undefined);
  if (subjects.length === 0) {
    return [{ ...base, subjectIndex: 1, inn: null, ogrn: null, subjectName: null, subjectType: null, mspCode: null, okved: null, okved2: null }];
  }
  return subjects.map((subj, i) => {
    const okved = asArray(subj.OKVEDS as Attrs[] | undefined).map((o) => attr(o, 'CODE')).find((c): c is string => !!c) ?? null;
    return {
      ...base,
      subjectIndex: i + 1,
      inn: attr(subj, 'INN'),
      ogrn: attr(subj, 'OGRN'),
      subjectName: attr(subj, 'NAME'),
      subjectType: attr(subj, 'TYPE'),
      mspCode: attr(subj, 'MSP_CODE'),
      okved,
      okved2: okved ? (/^(\d{2})/.exec(okved)?.[1] ?? null) : null,
    };
  });
}

/* ---------- чтение архива ---------- */

function openZipFile(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    openZip(path, { lazyEntries: true, autoClose: true }, (err, zip) => (err || !zip ? reject(err ?? new SourceError(SOURCE_ID, 'архив не открылся')) : resolve(zip)));
  });
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const done = () => { zip.removeListener('entry', onEntry); zip.removeListener('end', onEnd); zip.removeListener('error', onError); };
    const onEntry = (e: Entry) => { done(); resolve(e); };
    const onEnd = () => { done(); resolve(null); };
    const onError = (e: Error) => { done(); reject(e); };
    zip.on('entry', onEntry);
    zip.on('end', onEnd);
    zip.on('error', onError);
    zip.readEntry();
  });
}

function readEntryText(zip: ZipFile, entry: Entry): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) { reject(err ?? new SourceError(SOURCE_ID, `не открылся файл ${entry.fileName}`)); return; }
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

/** Записи плана из архива — файл за файлом, чтобы в памяти лежал один XML, а не весь набор. */
export async function* readDataset(zipPath: string, onProgress?: (files: number, records: number) => void): AsyncGenerator<InspectionRecord> {
  const zip = await openZipFile(zipPath);
  let files = 0;
  let records = 0;
  try {
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
      if (entry.fileName.endsWith('/') || !entry.fileName.toLowerCase().endsWith('.xml')) continue;
      const xml = await readEntryText(zip, entry);
      const parsed = parseInspectionsXml(xml);
      files += 1;
      records += parsed.length;
      for (const rec of parsed) yield rec;
      onProgress?.(files, records);
    }
  } finally {
    zip.close();
  }
}

/* ---------- регион по адресу объекта ---------- */

export interface RegionRef {
  /** Код региона «Работы России» (13 знаков) — общий ключ с остальными таблицами. */
  code: string;
  /** Код ФНС (две цифры). */
  fnsCode: string;
  name: string;
}

/** Слова-типы субъекта: в адресе они стоят то до названия («Респ Крым»), то после («Крым Респ»). */
const TYPE_WORDS = new Set(['республика', 'респ', 'область', 'обл', 'край', 'автономный', 'автономная', 'округ', 'ао', 'г', 'гор', 'город', 'федеральная', 'территория']);

/** Прилагательные, которые сами по себе встречаются в названиях улиц: отдельным признаком региона не считаем. */
const AMBIGUOUS_WORDS = new Set(['северная', 'южная', 'народная', 'новая']);

export function normalizeAddress(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9-]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

interface RegionAlias { tokens: string[]; region: RegionRef }

/**
 * Варианты написания названия региона для поиска в адресе: «Татарстан республика» из справочника
 * покрывает и «Респ Татарстан», и «Татарстан Респ», и «Республика Татарстан» — сравниваем по ядру
 * названия без слов-типов. Составные названия («Кемеровская область - Кузбасс») дают два варианта.
 */
export function buildRegionAliases(regions: readonly RegionRef[]): RegionAlias[] {
  const aliases: RegionAlias[] = [];
  for (const region of regions) {
    const groups: string[][] = [[]];
    for (const token of normalizeAddress(region.name)) {
      if (token === '-') { groups.push([]); continue; }
      groups[groups.length - 1]!.push(token);
    }
    const seen = new Set<string>();
    const add = (tokens: string[]) => {
      if (tokens.length === 0) return;
      const key = tokens.join(' ');
      if (seen.has(key)) return;
      seen.add(key);
      aliases.push({ tokens, region });
    };
    for (const group of groups) {
      const core = group.filter((t) => !TYPE_WORDS.has(t));
      add(core);
      if (core.length > 1) for (const t of core) if (t.length >= 4 && !AMBIGUOUS_WORDS.has(t)) add([t]);
    }
  }
  // Длинные варианты проверяем первыми: «ямало-ненецкий» не должен уступить «ненецкий».
  return aliases.sort((a, b) => b.tokens.length - a.tokens.length);
}

/**
 * Регион по адресу объекта контроля. Совпадение ищем по словам целиком (улица «Московское шоссе»
 * не считается Московской областью), при нескольких совпадениях берём самое длинное, а при равной
 * длине — самое раннее: субъект в адресе стоит перед улицей. Не определился — null, не угадываем.
 */
export function regionFromAddress(aliases: readonly RegionAlias[], address: string | null | undefined): RegionRef | null {
  if (!address) return null;
  const tokens = normalizeAddress(address);
  if (tokens.length === 0) return null;
  let best: { region: RegionRef; length: number; at: number } | null = null;
  for (const alias of aliases) {
    if (best && alias.tokens.length < best.length) break;
    const at = indexOfTokens(tokens, alias.tokens);
    if (at < 0) continue;
    if (!best || alias.tokens.length > best.length || at < best.at) best = { region: alias.region, length: alias.tokens.length, at };
  }
  return best?.region ?? null;
}

function indexOfTokens(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return -1;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
