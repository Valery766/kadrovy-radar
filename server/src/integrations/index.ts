export * as trudvsem from './trudvsem.js';
export * as rmsp from './rmsp.js';
export { SourceError, fetchJson, parseJsonLenient } from './http.js';

/** Реестр внешних источников — для бейджей «Источник · получено …» и README. */
export const SOURCES = {
  trudvsem: { id: 'trudvsem', title: '«Работа России» (Роструд)', url: 'https://trudvsem.ru/opendata/api', kind: 'live' as const },
  rmsp: { id: 'rmsp', title: 'Единый реестр субъектов МСП (ФНС России)', url: 'https://rmsp.nalog.ru/', kind: 'live' as const },
};
