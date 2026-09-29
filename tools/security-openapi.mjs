/** Test-only OpenAPI inventory. Source route names are extracted; request schemas are maintained below.
 * No credentials, real users or production data. Regenerate after any API change and verify against a live isolated target.
 * Fastify routes currently use TypeScript bodies/runtime checks, not JSON schemas; adding Swagger would not infer them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSignedInitData } from '../server/dist/api/auth.js';
const output = process.argv[2];
if (!output) throw new Error('Specify output artifact path');
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const str = (example, extra = {}) => ({ type: 'string', example, ...extra });
const num = (example) => ({ type: 'integer', example });
const bool = (example) => ({ type: 'boolean', example });
const salary = { type: 'integer', nullable: true, minimum: 1000, maximum: 5000000, example: 65000 };
const profession = { professionKey: str('povar'), professionText: str('повар'), regionFnsCode: str('78'), offer: salary };
// A valid baseline reaches the login implementation. Fuzzed signatures should still get 401.
const syntheticInitData = buildSignedInitData('synthetic-preview-bot-token-not-a-real-max-key', {
  auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 90001, first_name: 'ТЕСТ · Сканер' }),
});
const bodyByPath = {
  '/api/session': obj({ initData: str(syntheticInitData), demo: bool(false) }, ['initData']),
  '/api/profile': obj({ inn: str('7800000002') }, ['inn']),
  '/api/market': obj({ ...profession, inn: str(''), forceRefresh: bool(false), keepRegion: bool(true) }, ['professionKey', 'regionFnsCode']),
  '/api/staff': obj({ regionFnsCode: str('78'), positions: { type: 'array', items: obj({ title: str('повар'), salary }, ['title', 'salary']), example: [{ title: 'повар', salary: 65000 }] } }, ['regionFnsCode', 'positions']),
  '/api/regions/compare': obj({ ...profession, regionFnsCodes: { type: 'array', items: str('78'), example: ['78', '16'] }, sortBy: str('median') }, ['professionKey', 'regionFnsCodes']),
  '/api/cards/:id/vacancy': obj({ salary, text: str('ТЕСТ: синтетическая вакансия, не реальное предложение работы.', { maxLength: 3500 }), listed: bool(false), requestId: str('scan-publication-001', { minLength: 8, maxLength: 80, pattern: '^[a-zA-Z0-9_-]+$' }) }),
  '/api/cards/:id/vacancy-text': obj({ salary }),
  '/api/responses/:id/invite': obj({ message: str('ТЕСТ: синтетическое приглашение.', { maxLength: 2000 }) }),
  '/api/jobs/:id/apply': obj({ experience: str('mid', { enum: ['none', 'lt1', 'mid', 'senior'] }), schedule: bool(true), expectedSalary: salary, consent: bool(true) }, ['experience', 'schedule', 'expectedSalary', 'consent']),
  '/api/vacancies/:id/listing': obj({ listed: bool(true) }, ['listed']),
};
const queryByPath = {
  '/api/jobs': { q: str('повар', { maxLength: 120 }), region: str('78'), minSalary: num(50000), limit: num(12), offset: num(0) },
  '/api/professions/suggest': { q: str('повар'), limit: num(8) },
  '/api/inspections': { inn: str('') },
  '/api/regions/:fnsCode/digest': { professions: str('povar') },
};
const paths = {}; let operations = 0;
for (const file of ['server/src/api/routes.ts', 'server/src/api/jobs.ts']) {
  const source = readFileSync(resolve(file), 'utf8');
  for (const match of source.matchAll(/app\.(get|post|delete|put|patch)(?:<[^]*?>)?\(\s*['"]([^'"]+)['"]/g)) {
    const [, method, route] = match; const path = route.replace(/:(\w+)/g, '{$1}');
    const parameters = [];
    for (const [, name] of route.matchAll(/:(\w+)/g)) {
      const purpose = route.match(/\/(hire|invite|reject|listing|close)$/)?.[1];
      const example = name === 'fnsCode' ? '78' : route.startsWith('/api/cards') ? 'preview-card' : purpose ? `preview-${purpose}` : route.startsWith('/api/responses') ? 'preview-response' : route.startsWith('/api/subscriptions') ? 'preview-subscription' : route.startsWith('/api/jobs') ? 'preview-driver' : 'preview-cook';
      parameters.push({ name, in: 'path', required: true, schema: str(example) });
    }
    for (const [name, schema] of Object.entries(queryByPath[route] ?? {})) parameters.push({ name, in: 'query', required: false, schema });
    const operation = { operationId: `${method}_${route.replace(/\W+/g, '_')}`, parameters,
      responses: { 200: { description: 'Successful JSON response' }, 400: { description: 'Invalid input / unavailable operation' }, 401: { description: 'Missing or invalid session' }, 403: { description: 'Access denied' }, 404: { description: 'Entity not found' }, 409: { description: 'Hiring state conflict' }, 429: { description: 'Rate limit' }, 503: { description: 'External source unavailable' } } };
    if (!['/api/session', '/api/health'].includes(route)) operation.security = [{ session: [] }];
    if (method === 'post') {
      const schema = bodyByPath[route] ?? obj();
      const example = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([, s]) => 'example' in s).map(([k, s]) => [k, s.example]));
      operation.requestBody = { required: true, content: { 'application/json': { schema, example } } };
    }
    (paths[path] ??= {})[method] = operation; operations++;
  }
}
const spec = { openapi: '3.0.3', info: { title: 'Кадровый радар — isolated test inventory', version: '2026-09-27', description: 'Test-only route inventory and hand-derived request schemas. Heavy external integrations are blocked on the scan target, not scanned. Webhook transport is a separately unscanned surface.' }, servers: [{ url: 'http://127.0.0.1:8094' }], paths,
  components: { securitySchemes: { session: { type: 'http', scheme: 'bearer', description: 'Synthetic test session only; real MAX credentials must never be used here.' } } } };
writeFileSync(output, JSON.stringify(spec, null, 2));
console.log(`${operations} operations, ${Object.keys(paths).length} paths -> ${output}`);
