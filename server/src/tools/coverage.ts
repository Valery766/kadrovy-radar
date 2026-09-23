/**
 * Карта покрытия «регион × профессия»: сколько вакансий отдаёт «Работа России» по каждому
 * региону и профессии каталога. Артефакт для слайда о масштабировании и для порогов пакетов.
 * Запуск: npx tsx src/tools/coverage.ts > ../docs/coverage.json (≈ 20–30 минут, 8 параллельных запросов).
 */
import { resolve } from 'node:path';
import { loadCatalog } from '../packs/loader.js';
import { fetchPage } from '../integrations/trudvsem.js';

const catalog = loadCatalog(resolve(import.meta.dirname, '../../../packs'));
const tasks: { region: string; fnsCode: string; name: string; profession: string; query: string }[] = [];
for (const r of catalog.regions) for (const p of catalog.professions) tasks.push({ region: r.code, fnsCode: r.fnsCode, name: r.name, profession: p.key, query: p.query });

const results: Record<string, Record<string, number | null>> = {};
let done = 0;
const worker = async () => {
  for (let t = tasks.shift(); t; t = tasks.shift()) {
    let total: number | null = null;
    for (let attempt = 0; attempt < 2 && total == null; attempt += 1) {
      try { total = (await fetchPage(t.region, t.query, 0, 1)).total; } catch { /* retry */ }
    }
    (results[t.fnsCode] ??= {})[t.profession] = total;
    done += 1;
    if (done % 50 === 0) console.error(`${done} готово`);
  }
};
await Promise.all(Array.from({ length: 8 }, worker));
const out = { generatedAt: new Date().toISOString(), professions: catalog.professions.map((p) => ({ key: p.key, title: p.title })), regions: catalog.regions.map((r) => ({ fnsCode: r.fnsCode, name: r.name, totals: results[r.fnsCode] ?? {} })) };
console.log(JSON.stringify(out, null, 1));
