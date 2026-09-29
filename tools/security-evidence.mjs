/** Collect read-only, sanitized DAST evidence. No real key/.env access. */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const scanId = process.argv[2];
if (!/^[a-f0-9-]{36}$/i.test(scanId ?? '')) throw new Error('Expected scan UUID');
const surface = process.argv[3] ?? 'rest';
if (!['rest', 'spa'].includes(surface)) throw new Error('Unknown surface');
const artifactDir = resolve(process.env.SECURITY_ARTIFACT_DIR ?? '../../Доработка 27.09');
const hawk = resolve('../../Доработка 27.09/security-tools/hawk');
const redact = (value, key = '') => {
  if (/^(apiKey|api_key|password|token|secret|authorization|user)$/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  if (typeof value === 'string') return value.replace(/(Authorization:\s*(?:Bearer\s+)?)[^\r\n]+/gi, '$1[REDACTED]');
  return value;
};
const results = {};
for (const kind of ['uris', 'metrics', 'config', 'get']) {
  const args = ['op', 'scan', kind, scanId, '--format', 'json'];
  if (kind === 'get') args.push('--detail', 'full');
  results[kind] = await new Promise((done) => {
    const child = spawn(hawk, args, { cwd: artifactDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => { stdout += v; }); child.stderr.on('data', (v) => { stderr += v; });
    child.on('error', (e) => done({ error: e.message }));
    child.on('close', (code) => {
      let data; try { data = redact(JSON.parse(stdout)); } catch { data = { error: 'Non-JSON CLI result', exitCode: code, stderr: redact(stderr) }; }
      writeFileSync(resolve(artifactDir, `evidence-${scanId}-${kind}.json`), JSON.stringify(data, null, 2));
      done(data);
    });
  });
}
const spec = JSON.parse(readFileSync(resolve(artifactDir, 'openapi.json'), 'utf8'));
const expected = surface === 'rest' ? Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods).filter((m) => /^(get|post|put|patch|delete)$/.test(m)).map((m) => ({ method: m.toUpperCase(), path }))) : ['/app/', '/preview/employer', '/preview/candidate', '/preview/market', '/preview/home'].map((path) => ({ method: 'GET', path }));
const matches = (pattern, actual) => {
  const escaped = pattern.split(/(\{[^}]+\})/).map((p) => p.startsWith('{') ? '[^/]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${escaped}$`).test(actual);
};
const metrics = results.metrics.paths ?? [];
const uris = (results.uris.uris ?? []).map((u) => new URL(u).pathname);
const ops = expected.map((op) => {
  const rows = metrics.filter((m) => m.method === op.method && matches(op.path, m.path));
  return { ...op, uriReached: uris.some((p) => matches(op.path, p)), requests: rows.reduce((n, m) => n + m.total_requests, 0), successfulRequests: rows.reduce((n, m) => n + m.class_2xx, 0), statusCounts: rows.map((m) => m.status_counts), flags: [...new Set(rows.flatMap((m) => m.flags ?? []))] };
});
const liveSourceRoutes = [];
for (const file of ['server/src/api/routes.ts', 'server/src/api/jobs.ts']) {
  for (const [, method, path] of readFileSync(file, 'utf8').matchAll(/app\.(get|post|delete|put|patch)(?:<[^]*?>)?\(\s*['"]([^'"]+)['"]/g)) liveSourceRoutes.push(`${method.toUpperCase()} ${path.replace(/:(\w+)/g, '{$1}')}`);
}
const gaps = [];
if (ops.some((o) => !o.uriReached)) gaps.push('coverage-gap');
if (ops.some((o) => o.flags.includes('auth-wall'))) gaps.push('auth-wall');
// The quality gate concerns an entire configured surface returning only 4xx.
// Individual rate-limited/fixture-exhausted operations stay visible in operationsWithoutSuccess.
if (ops.some((o) => o.requests) && ops.every((o) => !o.successfulRequests)) gaps.push('all-4xx');
const report = {
  timestamp: new Date().toISOString(), scanId, surface, freshSourceOperations: liveSourceRoutes.length,
  specOperations: expected.length, specPaths: new Set(expected.map((o) => o.path)).size,
  missingFromSpec: surface === 'rest' ? liveSourceRoutes.filter((r) => !expected.some((o) => `${o.method} ${o.path}` === r)) : [],
  scannedUris: uris.length, reachedSpecPaths: [...new Set(expected.map((o) => o.path))].filter((p) => uris.some((u) => matches(p, u))).length,
  successfulOperations: ops.filter((o) => o.successfulRequests > 0).length,
  scanFlags: results.metrics.scan_flags ?? null, requestHealth: results.metrics.request_health ?? null,
  gapReasons: gaps, operations: ops,
  limitations: ['Raw production webhook is not mounted on this isolated target: surface-unscanned.', 'Government APIs and real MAX delivery are intentionally blocked; not audited by this scan.', 'State-changing operations may exhaust their synthetic fixtures; 409 is not itself a vulnerability.', 'Rate limiting is retained; 429 constrains payload coverage.', 'URI presence is not proof that every payload/branch was exercised.', ...(surface === 'spa' ? ['Client screens use React state rather than unique URL routes. Seed-page reachability alone is not evidence of every screen/button being exercised. The MAX bridge is a synthetic local fixture.'] : [])],
};
writeFileSync(resolve(artifactDir, `quality-${scanId}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ scanId, sourceOperations: report.freshSourceOperations, specPaths: report.specPaths, reachedSpecPaths: report.reachedSpecPaths, successfulOperations: report.successfulOperations, scanFlags: report.scanFlags, requestHealth: report.requestHealth, gapReasons: gaps, operationsWithoutSuccess: ops.filter((o) => !o.successfulRequests).map(({ method, path, flags }) => ({ method, path, flags })), getShape: Object.keys(results.get) }, null, 2));
