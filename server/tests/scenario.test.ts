import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadCatalog, selectPack } from '../src/packs/loader.js';
import { findProfession, findRegion } from '../src/bot/scenario.js';
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
  it('builds stable idempotency keys for updates', () => {
    const u = { update_type: 'message_created', timestamp: 1, message: { body: { mid: 'mid.1' } } } as never;
    expect(updateKey(u)).toBe('message_created:1:mid.1');
    const cb = { update_type: 'message_callback', timestamp: 2, callback: { callback_id: 'cb1' } } as never;
    expect(updateKey(cb)).toBe('message_callback:2:cb1');
  });
});
