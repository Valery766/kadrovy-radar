import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadCatalog, selectPack } from '../src/packs/loader.js';
import { findProfession, findRegion, parseRegionList, parseStaffLine, splitText } from '../src/bot/scenario.js';
import { isValidInn } from '../src/integrations/rmsp.js';
import { updateKey } from '../src/bot/updates.js';

const catalog = loadCatalog(resolve(import.meta.dirname, '../../packs'));

describe('bot helpers', () => {
  it('recognises regions by name and aliases', () => {
    expect(findRegion(catalog, 'Санкт-Петербург')?.fnsCode).toBe('78');
    expect(findRegion(catalog, 'спб')?.fnsCode).toBe('78');
    expect(findRegion(catalog, 'татарстан')?.fnsCode).toBe('16');
    expect(findRegion(catalog, 'Московская область')?.fnsCode).toBe('50');
    expect(findRegion(catalog, 'абракадабра')).toBeNull();
    expect(findRegion(catalog, 'ок')).toBeNull();
    expect(findRegion(catalog, 'область')).toBeNull();
    expect(findRegion(catalog, 'Свердловская')?.fnsCode).toBe('66');
  });
  it('recognises professions from free text within the pack and catalog', () => {
    const pack = selectPack(catalog, { fnsRegionCode: '78', okved: '56.10' });
    expect(findProfession(catalog, pack, 'повар')?.key).toBe('povar');
    expect(findProfession(catalog, pack, 'Нужен повар-универсал')?.key).toBe('povar');
    expect(findProfession(catalog, pack, 'шеф-повар')).toBeNull();
    expect(findProfession(catalog, pack, 'сварщик')?.key).toBe('svarshchik');
    expect(findProfession(catalog, pack, 'космонавт')).toBeNull();
  });
  it('validates INN checksums', () => {
    expect(isValidInn('7801633015')).toBe(true);
    expect(isValidInn('1601000159')).toBe(true);
    expect(isValidInn('7801633016')).toBe(false);
    expect(isValidInn('123')).toBe(false);
    expect(isValidInn('781512345678')).toBe(false);
  });
  it('parses staff lines «должность ставка»', () => {
    expect(parseStaffLine('повар 60000')).toEqual({ title: 'повар', salary: 60000 });
    expect(parseStaffLine('  официант — 45 000 ₽ ')).toEqual({ title: 'официант', salary: 45000 });
    expect(parseStaffLine('администратор 70 тыс')).toEqual({ title: 'администратор', salary: 70000 });
    expect(parseStaffLine('повар 5 разряда 60000')).toEqual({ title: 'повар 5 разряда', salary: 60000 });
    expect(parseStaffLine('повар')).toBeNull();
    expect(parseStaffLine('60000')).toBeNull();
    expect(parseStaffLine('повар 60')).toEqual({ title: 'повар', salary: 60000 }); // «60» — это 60 тысяч
    expect(parseStaffLine('сушист 0')).toBeNull(); // ставка ниже минимальной — строка не принимается
    // Длинная строка не прогоняется через регулярку: 200 символов — предел, 201 отбрасывается.
    expect(parseStaffLine(`${'п'.repeat(194)} 60000`)).toEqual({ title: 'п'.repeat(194), salary: 60000 });
    expect(parseStaffLine(`${'п'.repeat(195)} 60000`)).toBeNull();
    expect(parseStaffLine(`${'повар '.repeat(60)}60000`)).toBeNull();
    expect(parseStaffLine('')).toBeNull();
  });

  it('parses a region list and reports what it did not recognise', () => {
    const r = parseRegionList(catalog, 'СПб, Татарстан, Москва, Атлантида', 4);
    expect(r.regions.map((x) => x.fnsCode)).toEqual(['78', '16', '77']);
    expect(r.unknown).toEqual(['Атлантида']);
    expect(parseRegionList(catalog, 'СПб, спб, Санкт-Петербург', 4).regions).toHaveLength(1);
    expect(parseRegionList(catalog, 'СПб, Москва, Татарстан, Свердловская, Новосибирск', 3).regions).toHaveLength(3);
    expect(parseRegionList(catalog, 'абракадабра', 4).regions).toHaveLength(0);
  });

  it('splits long texts within the MAX message limit by line boundaries', () => {
    const line = 'а'.repeat(120);
    const text = Array.from({ length: 60 }, () => line).join('\n');
    const parts = splitText(text, 1000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((x) => x.length <= 1000)).toBe(true);
    expect(parts.join('\n')).toBe(text);
    expect(splitText('короткий текст')).toEqual(['короткий текст']);
    expect(splitText('б'.repeat(2500), 1000).every((x) => x.length <= 1000)).toBe(true);
  });

  it('builds stable idempotency keys for updates', () => {
    const u = { update_type: 'message_created', timestamp: 1, message: { body: { mid: 'mid.1' } } } as never;
    expect(updateKey(u)).toBe('message_created:1:mid.1');
    const cb = { update_type: 'message_callback', timestamp: 2, callback: { callback_id: 'cb1' } } as never;
    expect(updateKey(cb)).toBe('message_callback:2:cb1');
  });
});
