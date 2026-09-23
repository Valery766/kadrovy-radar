import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadCatalog, selectPack, prettyRegionName, regionByFnsCode } from '../src/packs/loader.js';

const catalog = loadCatalog(resolve(import.meta.dirname, '../../packs'));

describe('packs', () => {
  it('loads all packs and shared dictionaries', () => {
    expect(catalog.packs.length).toBeGreaterThanOrEqual(3);
    expect(catalog.professions.length).toBeGreaterThan(5);
    expect(catalog.regions.length).toBeGreaterThan(80);
  });
  it('selects exact, region-only and generic packs', () => {
    expect(selectPack(catalog, { fnsRegionCode: '78', okved: '56.10' }).id).toBe('spb-obschepit');
    expect(selectPack(catalog, { fnsRegionCode: '16', okved: '47.11' }).id).toBe('tatarstan-roznitsa');
    expect(selectPack(catalog, { fnsRegionCode: '16', okved: '25.11' }).id).toBe('tatarstan-roznitsa');
    expect(selectPack(catalog, { fnsRegionCode: '77', okved: '56.10' }).id).toBe('generic');
    expect(selectPack(catalog, { fnsRegionCode: null, okved: null }).id).toBe('generic');
  });
  it('maps FNS region codes to Работа России codes', () => {
    expect(regionByFnsCode(catalog, '78')?.code).toBe('7800000000000');
    expect(regionByFnsCode(catalog, '16')?.name).toBe('Республика Татарстан');
    expect(prettyRegionName('г Москва')).toBe('Москва');
    expect(prettyRegionName('Тюменская область')).toBe('Тюменская область');
  });
});
