/** Uses authenticated local Hawk CLI. Never reads/prints the real StackHawk API key or the project's .env. */
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signSession } from '../server/dist/api/auth.js';
const runtimeDir = resolve('../../Доработка 27.09');
const artifactDir = resolve(process.env.SECURITY_ARTIFACT_DIR ?? '../../Доработка 27.09');
const command = process.argv[2] ?? 'validate';
const surface = process.argv[3] ?? 'rest';
if (!['rest', 'spa'].includes(surface)) throw new Error('Unknown surface');
const config = `stackhawk-${surface}.yml`;
const scanToken = signSession('synthetic-preview-session-secret-32-chars', { uid: 90001, name: 'ТЕСТ · Сканер', chatId: 90001, demo: false, exp: Math.floor(Date.now() / 1000) + 12 * 3600 });
const env = { ...process.env, SCAN_TOKEN: scanToken, STACKHAWK_ENV: `Development-${surface}`, COMMIT_SHA: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), BRANCH_NAME: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), HAWK_AGENT: 'codex', _STACKHAWK_AGENT: 'codex', _STACKHAWK_SKILL: 'hawkscan' };
if (command === 'resolve') {
  const checks = [];
  for (const path of ['/api/bootstrap', '/api/jobs', '/api/jobs/preview-driver', '/api/vacancies/preview-cook/responses', '/api/cards/preview-card']) {
    const anonymous = await fetch(`http://127.0.0.1:8094${path}`);
    const authenticated = await fetch(`http://127.0.0.1:8094${path}`, { headers: { authorization: `Bearer ${scanToken}` } });
    checks.push({ path, anonymous: anonymous.status, authenticated: authenticated.status });
  }
  writeFileSync(resolve(artifactDir, 'resolve-check.json'), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify(checks, null, 2));
  if (checks.some((c) => c.anonymous !== 401 || c.authenticated !== 200)) process.exit(1);
} else {
  const args = command === 'validate' ? ['validate', 'config', config] : command === 'auth' ? ['validate', 'auth', config, '--hawk-mem=3g'] : command === 'api' ? ['validate', 'api', config, '--hawk-mem=3g'] : command === 'scan' ? ['--no-color', 'scan', config, '--json-output', '--hawk-mem=3g'] : command === 'rescan' && process.argv[4] ? ['--no-color', 'rescan', config, '--scan-id', process.argv[4], '--json-output', '--hawk-mem=3g'] : null;
  if (!args) throw new Error('Unknown command or missing scan ID');
  const child = spawn(resolve(runtimeDir, 'security-tools/hawk'), args, { cwd: artifactDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
  child.on('error', (err) => { console.error(err.message); process.exitCode = 1; });
  child.on('close', (code) => {
    writeFileSync(resolve(artifactDir, `${command}-${surface}.log`), stdout + '\nSTDERR\n' + stderr);
    writeFileSync(resolve(artifactDir, `${command}-${surface}-status.json`), JSON.stringify({ timestamp: new Date().toISOString(), exitCode: code, surface, commit: env.COMMIT_SHA, dirty: true }, null, 2));
    if (['scan', 'rescan'].includes(command)) writeFileSync(resolve(artifactDir, `${command}-${surface}.json`), stdout);
    process.exitCode = code ?? 1;
  });
}
