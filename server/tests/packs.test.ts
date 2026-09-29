import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  loadCatalog, selectPack, prettyRegionName, regionByFnsCode,
  resolveProfession, suggestProfessions, professionSlug, isCustomProfessionKey,
} from '../src/packs/loader.js';

const catalog = loadCatalog(resolve(import.meta.dirname, '../../packs'));

describe('packs', () => {
  it('loads all packs and shared dictionaries', () => {
    expect(catalog.packs.length).toBeGreaterThanOrEqual(3);
    expect(catalog.professions.length).toBeGreaterThan(5);
    expect(catalog.regions.length).toBeGreaterThan(80);
  });
  it('loads the OKPDTR reference for free-text suggestions', () => {
    expect(catalog.okpdtr.length).toBeGreaterThan(8000);
    expect(catalog.okpdtr.every((e) => e.code && e.name)).toBe(true);
  });
  it('selects exact, region-only and generic packs', () => {
    expect(selectPack(catalog, { fnsRegionCode: '78', okved: '56.10' }).id).toBe('spb-obschepit');
    expect(selectPack(catalog, { fnsRegionCode: '23', okved: '01.25' }).id).toBe('apk-sezon');
    expect(selectPack(catalog, { fnsRegionCode: '23', okved: '01.11' }).id).toBe('apk-sezon');
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
  it('renders republics, duplicated types and federal territories the way they are written officially', () => {
    expect(prettyRegionName('Адыгея республика')).toBe('Республика Адыгея');
    expect(prettyRegionName('Саха (Якутия) республика')).toBe('Республика Саха (Якутия)');
    expect(prettyRegionName('Северная Осетия - Алания республика')).toBe('Республика Северная Осетия - Алания');
    expect(prettyRegionName('Кабардино-Балкарская республика')).toBe('Кабардино-Балкарская Республика');
    expect(prettyRegionName('Донецкая Народная республика')).toBe('Донецкая Народная Республика');
    expect(prettyRegionName('Чувашская Республика - чувашия')).toBe('Чувашская Республика');
    expect(prettyRegionName('Кемеровская область - Кузбасс область')).toBe('Кемеровская область - Кузбасс');
    expect(prettyRegionName('Ханты-Мансийский Автономный округ - Югра автономный округ')).toBe('Ханты-Мансийский автономный округ - Югра');
    expect(prettyRegionName('Ямало-Ненецкий автономный округ')).toBe('Ямало-Ненецкий автономный округ');
    expect(prettyRegionName('Сириус федеральная территория')).toBe('Федеральная территория Сириус');
  });
  it('leaves no region name with the type word stuck at the end', () => {
    for (const r of catalog.regions) expect(r.name, r.name).not.toMatch(/\s(республика|федеральная территория)$/);
    for (const r of catalog.regions) expect(r.name, r.name).not.toMatch(/^г\s/i);
  });
});

describe('free-text profession', () => {
  const pack = selectPack(catalog, { fnsRegionCode: '78', okved: '56.10' });

  it('recognises catalog professions by title and synonyms', () => {
    expect(resolveProfession(catalog, pack, 'повар')!.key).toBe('povar');
    expect(resolveProfession(catalog, pack, '  ПОВАР ')!.key).toBe('povar');
    expect(resolveProfession(catalog, pack, 'бариста')!.key).toBe('barmen');
    expect(resolveProfession(catalog, pack, 'тракторист')!.key).toBe('traktorist');
    expect(resolveProfession(catalog, null, 'продавец')!.key).toBe('prodavets');
  });

  it('builds a custom profession for anything else', () => {
    const p = resolveProfession(catalog, pack, 'обвальщик мяса')!;
    expect(isCustomProfessionKey(p.key)).toBe(true);
    expect(p.key).toMatch(/^custom:[a-z0-9-]+$/);
    expect(p.title).toBe('Обвальщик мяса');
    expect(p.query).toBe('обвальщик мяса');
    expect(p.synonyms).toEqual(['обвальщик мяса']);
    expect(p.exclude).toEqual([]);
  });

  it('gives the same key for the same text and different keys for different texts', () => {
    expect(resolveProfession(catalog, pack, 'обвальщик мяса')!.key).toBe(resolveProfession(catalog, pack, '  Обвальщик   мяса ')!.key);
    expect(professionSlug('обвальщик мяса')).not.toBe(professionSlug('жиловщик мяса'));
    expect(professionSlug('ёлочник')).toBe(professionSlug('елочник')); // нормализация ё → е
    expect(resolveProfession(catalog, pack, '   ')).toBeNull();
  });

  it('suggests catalog professions first, then OKPDTR positions', () => {
    const s = suggestProfessions(catalog, 'повар', 5);
    expect(s[0]!.key).toBe('povar');
    expect(s[0]!.source).toBe('catalog');
    expect(s.length).toBeGreaterThan(1);
    expect(s.some((x) => x.source === 'okpdtr' && x.code)).toBe(true);
    expect(s.every((x) => x.title.toLowerCase().includes('повар'))).toBe(true);
  });

  it('suggests OKPDTR positions absent from the catalog and keeps the limit', () => {
    const s = suggestProfessions(catalog, 'обвальщик', 3);
    expect(s.length).toBeGreaterThan(0);
    expect(s.length).toBeLessThanOrEqual(3);
    expect(s[0]!.source).toBe('okpdtr');
    expect(isCustomProfessionKey(s[0]!.key)).toBe(true);
    expect(suggestProfessions(catalog, 'о')).toEqual([]);
    expect(suggestProfessions(catalog, 'ъъъъъ')).toEqual([]);
  });

  it('turns a suggestion into a profession with the same key', () => {
    const s = suggestProfessions(catalog, 'обвальщик', 1)[0]!;
    expect(resolveProfession(catalog, pack, s.title)!.key).toBe(s.key);
  });
});
