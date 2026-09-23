import { resolve } from 'node:path';
import { loadCatalog } from './loader.js';

const dir = resolve(process.argv[2] ?? resolve(import.meta.dirname, '../../../packs'));
try {
  const c = loadCatalog(dir);
  for (const p of c.packs) {
    console.log(`✔ ${p.id} (v${p.version}): ${p.title} — регион ${p.region ? `${p.region.name} [${p.region.fnsCode}]` : 'любой'}, отрасль ${p.industry ? p.industry.okvedPrefixes.join('/') : 'любая'}, профессий ${p.professions.length}, демо ${p.demo ? p.demo.inn : '—'}`);
  }
  console.log(`Каталог: ${c.professions.length} профессий, ${c.phrases.length} формулировок, ${c.regions.length} регионов. Всё валидно.`);
} catch (e) {
  console.error(`✖ ${(e as Error).message}`);
  process.exit(1);
}
