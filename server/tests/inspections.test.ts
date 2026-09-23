import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildRegionAliases, normalizeKind, normalizeUrl, parseInspectionsXml, regionFromAddress, versionFromFileName } from '../src/integrations/erknm.js';
import { beginInspectionsLoad, getInspectionDataset, inspectionCounts, inspectionsByInn, openDb, replaceInspections, type Db, type InspectionRow } from '../src/db/index.js';
import { loadCatalog } from '../src/packs/loader.js';
import { loadConfig } from '../src/config.js';
import { inspectionsForBusiness, inspectionsProfileLine, inspectionsText } from '../src/services/inspections.js';

const PACKS_DIR = resolve(import.meta.dirname, '../../packs');
const catalog = loadCatalog(PACKS_DIR);
const config = loadConfig({ MAX_UPDATES_MODE: 'none', PACKS_DIR, DATA_DIR: '/tmp/stavka-test-erknm', ERKNM_YEAR: '2026' });
const aliases = buildRegionAliases(catalog.regions);
const fixture = readFileSync(resolve(import.meta.dirname, 'fixtures/erknm-plan-sample.xml'), 'utf8');

const ctx = (db: Db) => ({ db, config, catalog, log: { info: () => undefined, warn: () => undefined } });

describe('erknm: паспорт набора', () => {
  it('чинит двойной слэш в ссылках паспорта', () => {
    expect(normalizeUrl('https://proverki.gov.ru//blob/erknm-plan/2026/data.zip')).toBe('https://proverki.gov.ru/blob/erknm-plan/2026/data.zip');
    expect(normalizeUrl('https://proverki.gov.ru/blob/x.zip')).toBe('https://proverki.gov.ru/blob/x.zip');
  });
  it('берёт версию набора из имени архива', () => {
    expect(versionFromFileName('data-20260923-structure-20220115.zip')).toBe('2026-09-23');
    expect(versionFromFileName('что-то-другое.zip')).toBeNull();
  });
});

describe('erknm: вид надзора', () => {
  it('раскладывает формулировки реестра по четырём группам', () => {
    expect(normalizeKind('Федеральный государственный контроль (надзор) за соблюдением трудового законодательства и иных нормативных правовых актов, содержащих нормы трудового права')).toBe('labor');
    expect(normalizeKind('Федеральный государственный санитарно-эпидемиологический контроль (надзор)')).toBe('sanitary');
    expect(normalizeKind('Федеральный государственный пожарный надзор')).toBe('fire');
    expect(normalizeKind('Федеральный государственный ветеринарный контроль (надзор)')).toBe('other');
    expect(normalizeKind(null)).toBe('other');
  });
});

describe('erknm: регион по адресу объекта', () => {
  // Названия в каталоге приведены к читаемому виду («Татарстан республика» → «Республика Татарстан»).
  const name = (address: string) => regionFromAddress(aliases, address)?.name ?? null;

  it('узнаёт субъект в разных формах записи', () => {
    expect(name('422230, Респ Татарстан, г Агрыз, ул Карла Маркса, д 1')).toBe('Республика Татарстан');
    expect(name('Татарстан Респ, Сабинский муниципальный район, с Старая Икшурма')).toBe('Республика Татарстан');
    expect(name('Российская Федерация, Республика Татарстан, г Казань')).toBe('Республика Татарстан');
    expect(name('Город Москва, вн.тер.г. муниципальный округ Ясенево, ул Рокотова, д.4')).toBe('Москва');
    expect(name('г. Москва, Юннатов ул., д. 16А')).toBe('Москва');
    expect(name('г Санкт-Петербург, Малый пр-кт В.О., д 43')).toBe('Санкт-Петербург');
    expect(name('Санкт-Петербург г, ул Савушкина, д 1')).toBe('Санкт-Петербург');
    expect(name('обл Московская, г Мытищи, ш Ярославское, Строение 141')).toBe('Московская область');
    expect(name('633265, НОВОСИБИРСКАЯ ОБЛАСТЬ, ОРДЫНСКИЙ РАЙОН, ПРОЛЕТАРСКИЙ ПОСЕЛОК')).toBe('Новосибирская область');
  });

  it('различает похожие названия и не путает регион с улицей', () => {
    expect(name('Ямало-Ненецкий АО, г Ноябрьск, мкр Вынгапуровский')).toBe('Ямало-Ненецкий автономный округ');
    expect(name('Ненецкий АО, г Нарьян-Мар, ул Ленина, д 1')).toBe('Ненецкий автономный округ');
    expect(name('Респ Алтай, г Горно-Алтайск, ул Чорос-Гуркина')).toBe('Республика Алтай');
    expect(name('Алтайский край, р-н Ребрихинский, с Усть-Мосиха')).toBe('Алтайский край');
    // Название региона в имени улицы не перебивает субъект, который стоит в начале адреса.
    expect(name('Ярославская обл, г Ярославль, пр-кт Московский, д.101')).toBe('Ярославская область');
    expect(name('обл Костромская, р-н Костромской д. Асташево, ул. Московская, д.2')).toBe('Костромская область');
  });

  it('не угадывает регион, если субъекта в адресе нет', () => {
    expect(name('г Ярославль, ул Чкалова, д 20а')).toBeNull();
    expect(name('ул Ленина, д 5')).toBeNull();
    expect(regionFromAddress(aliases, null)).toBeNull();
    expect(regionFromAddress(aliases, '')).toBeNull();
  });
});

describe('erknm: разбор XML плана', () => {
  const records = parseInspectionsXml(fixture);

  it('даёт по записи на каждый субъект мероприятия', () => {
    expect(records).toHaveLength(4);
    expect(records.map((r) => r.erpId)).toEqual(['11111111111111111111', '22222222222222222222', '22222222222222222222', '33333333333333333333']);
    expect(records.map((r) => r.subjectIndex)).toEqual([1, 1, 2, 1]);
    expect(new Set(records.map((r) => r.year))).toEqual(new Set([2026]));
  });

  it('вытаскивает субъекта, вид надзора, орган и даты', () => {
    const labor = records[0]!;
    expect(labor).toMatchObject({
      inn: '1601000159',
      ogrn: '1021607550000',
      subjectType: 'ЮЛ',
      mspCode: 'Малое предприятие',
      okved: '47.11',
      okved2: '47',
      kind: 'labor',
      kindKnm: 'Выездная проверка',
      typeName: 'Плановое КНМ',
      status: 'Ожидает проведения',
      startDate: '2026-02-02',
      stopDate: '2026-02-13',
      organization: 'ГОСУДАРСТВЕННАЯ ИНСПЕКЦИЯ ТРУДА В РЕСПУБЛИКЕ ТАТАРСТАН',
      prosecutorOffice: 'Прокуратура Республики Татарстан',
    });
    expect(labor.kindControl).toContain('трудового законодательства');
    expect(labor.subjectName).toContain('АГРЫЗСКОЕ');
  });

  it('берёт адрес объекта, а при его отсутствии — место проведения КНМ', () => {
    expect(records[0]!.addresses).toEqual(['422230, Респ Татарстан, г Агрыз, ул Карла Маркса, д 1']);
    expect(records[1]!.addresses).toEqual(['г Санкт-Петербург, Малый пр-кт В.О., д 43']);
    expect(records[3]!.addresses).toEqual(['г Ярославль, ул Чкалова, д 20а']);
  });

  it('переживает запись без ОКВЭД и пустой ввод', () => {
    expect(records[3]!.okved).toBeNull();
    expect(records[3]!.okved2).toBeNull();
    expect(parseInspectionsXml('не xml')).toEqual([]);
  });
});

/** Записи фикстуры, разложенные так же, как это делает загрузка набора. */
function fixtureRows(): InspectionRow[] {
  return parseInspectionsXml(fixture).map((rec) => {
    const address = rec.addresses.find((a) => regionFromAddress(aliases, a)) ?? rec.addresses[0] ?? null;
    const region = regionFromAddress(aliases, address);
    return {
      id: `${rec.erpId}-${rec.subjectIndex}`, year: 2026, erpId: rec.erpId,
      inn: rec.inn, ogrn: rec.ogrn, subjectName: rec.subjectName, subjectType: rec.subjectType, mspCode: rec.mspCode,
      okved: rec.okved, okved2: rec.okved2, kind: rec.kind, kindControl: rec.kindControl, kindKnm: rec.kindKnm,
      typeName: rec.typeName, status: rec.status, startDate: rec.startDate, stopDate: rec.stopDate,
      organization: rec.organization, prosecutorOffice: rec.prosecutorOffice, address,
      regionCode: region?.code ?? null, regionFnsCode: region?.fnsCode ?? null,
    };
  });
}

const DATASET = { year: 2026, datasetId: '7710146102-plan-2026', version: '2026-09-23', fileName: 'data-20260923-structure-20220115.zip' };

describe('erknm: хранилище', () => {
  it('кладёт набор, ищет по ИНН и считает контекст', () => {
    const db = openDb(':memory:');
    const dataset = replaceInspections(db, DATASET, fixtureRows());
    expect(dataset.records).toBe(4);
    // Ярославль без субъекта в адресе — регион не определён, и мы его не выдумываем.
    expect(dataset.withRegion).toBe(3);

    const own = inspectionsByInn(db, '1601000159', 2026);
    expect(own).toHaveLength(1);
    expect(own[0]!.kind).toBe('labor');
    expect(own[0]!.regionFnsCode).toBe('16');
    expect(inspectionsByInn(db, '7810000000', 2026)[0]!.kind).toBe('sanitary');
    expect(inspectionsByInn(db, '0000000000', 2026)).toEqual([]);

    const spb = catalog.regions.find((r) => r.fnsCode === '78')!;
    expect(inspectionCounts(db, 2026, { regionCode: spb.code })).toEqual({ byKind: { labor: 0, sanitary: 2, fire: 0, other: 0 }, total: 2 });
    expect(inspectionCounts(db, 2026, { regionCode: spb.code, okved2: '56' })).toEqual({ byKind: { labor: 0, sanitary: 2, fire: 0, other: 0 }, total: 2 });
    expect(inspectionCounts(db, 2026, { regionCode: spb.code, okved2: '01' }).total).toBe(0);
    db.close();
  });

  it('перезаливает набор идемпотентно, без дублей', () => {
    const db = openDb(':memory:');
    replaceInspections(db, DATASET, fixtureRows());
    const again = replaceInspections(db, { ...DATASET, version: '2026-09-24', fileName: 'data-20260924-structure-20220115.zip' }, fixtureRows());
    expect(again.records).toBe(4);
    expect((db.prepare('SELECT COUNT(*) AS n FROM inspections').get() as { n: number }).n).toBe(4);
    expect(getInspectionDataset(db, 2026)?.version).toBe('2026-09-24');
    db.close();
  });

  it('не оставляет половину набора, если загрузка оборвалась', () => {
    const db = openDb(':memory:');
    replaceInspections(db, DATASET, fixtureRows());
    const loader = beginInspectionsLoad(db, 2026);
    loader.add(fixtureRows()[0]!);
    loader.abort();
    expect((db.prepare('SELECT COUNT(*) AS n FROM inspections').get() as { n: number }).n).toBe(4);
    expect(getInspectionDataset(db, 2026)?.version).toBe('2026-09-23');
    db.close();
  });
});

describe('inspectionsForBusiness', () => {
  it('отвечает «данных ещё нет», пока набор не загружен', () => {
    const db = openDb(':memory:');
    const r = inspectionsForBusiness(ctx(db), { inn: '1601000159', regionFnsCode: '16', okved: '47.11' });
    expect(r.loaded).toBe(false);
    expect(r.own).toEqual([]);
    expect(r.dataset).toBeNull();
    expect(inspectionsText(r)).toContain('ещё не загружен');
    expect(inspectionsProfileLine(r)).toBeNull();
    db.close();
  });

  it('отдаёт плановые КНМ по ИНН и счётчики по региону и разделу ОКВЭД', () => {
    const db = openDb(':memory:');
    replaceInspections(db, DATASET, fixtureRows());
    const r = inspectionsForBusiness(ctx(db), { inn: '1601000159', regionFnsCode: '16', okved: '47.11' });
    expect(r.loaded).toBe(true);
    expect(r.own).toHaveLength(1);
    expect(r.own[0]).toMatchObject({ kind: 'labor', kindLabel: 'трудовая инспекция', kindKnm: 'Выездная проверка', startDate: '2026-02-02' });
    expect(r.context.scope).toBe('region_okved');
    expect(r.context.okved2).toBe('47');
    expect(r.context.byKind).toEqual({ labor: 1, sanitary: 0, fire: 0, other: 0 });
    expect(r.dataset).toMatchObject({ year: 2026, version: '2026-09-23', records: 4, withRegion: 3 });

    const text = inspectionsText(r);
    expect(text).toContain('По ИНН 1601000159 в плане проверок 2026: 1.');
    expect(text).toContain('02.02.2026 – 13.02.2026');
    expect(text).toContain('ГОСУДАРСТВЕННАЯ ИНСПЕКЦИЯ ТРУДА В РЕСПУБЛИКЕ ТАТАРСТАН');
    expect(text).toContain('версия набора от 23.09.2026');
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(inspectionsProfileLine(r)).toBe('Проверки 2026: 1 плановая проверка по вашему ИНН, кто и когда придёт: /checks');
    expect(text).not.toContain('—');
    expect(text).toContain('Что дальше');
    db.close();
  });

  it('без плановых КНМ показывает только контекст региона', () => {
    const db = openDb(':memory:');
    replaceInspections(db, DATASET, fixtureRows());
    const r = inspectionsForBusiness(ctx(db), { inn: '7802000000', regionFnsCode: '78', okved: '56.10' });
    expect(r.own).toEqual([]);
    expect(r.context.byKind.sanitary).toBe(2);
    expect(inspectionsText(r)).toContain('плановых проверок в плане 2026 года нет');
    expect(inspectionsProfileLine(r)).toContain('плановых по вашему ИНН нет');
    db.close();
  });

  it('держит текст для чата в пределах лимита MAX даже при длинном плане', () => {
    const db = openDb(':memory:');
    const base = fixtureRows()[0]!;
    // 40 КНМ по одному ИНН с длинными формулировками реестра — так бывает у сетей с множеством объектов.
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...base,
      id: `9${String(i).padStart(19, '0')}-1`,
      erpId: `9${String(i).padStart(19, '0')}`,
      organization: 'ГЛАВНОЕ УПРАВЛЕНИЕ МИНИСТЕРСТВА РОССИЙСКОЙ ФЕДЕРАЦИИ ПО ДЕЛАМ ГРАЖДАНСКОЙ ОБОРОНЫ, ЧРЕЗВЫЧАЙНЫМ СИТУАЦИЯМ И ЛИКВИДАЦИИ ПОСЛЕДСТВИЙ СТИХИЙНЫХ БЕДСТВИЙ ПО РЕСПУБЛИКЕ ТАТАРСТАН',
    }));
    replaceInspections(db, DATASET, many);
    const r = inspectionsForBusiness(ctx(db), { inn: base.inn!, regionFnsCode: '16', okved: '47.11' });
    const text = inspectionsText(r);
    expect(r.own.length).toBeGreaterThan(10);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain('и ещё');
    expect(text).toContain('версия набора от 23.09.2026');
    db.close();
  });

  it('без региона не придумывает контекст', () => {
    const db = openDb(':memory:');
    replaceInspections(db, DATASET, fixtureRows());
    const r = inspectionsForBusiness(ctx(db), { inn: '1601000159' });
    expect(r.context.scope).toBe('none');
    expect(r.context.total).toBe(0);
    expect(r.own).toHaveLength(1);
    db.close();
  });
});
