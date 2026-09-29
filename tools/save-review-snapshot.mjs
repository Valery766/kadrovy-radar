/** Secret-excluding review snapshot of tracked and new source, not a final competition submission. */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const artifactDir = resolve('../../Доработка 27.09');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const list = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const files = [...new Set(list)].filter((p) => {
  if (/^(?:docs\/shots\/|\.git\/)|(?:^|\/)(?:node_modules|\.venv)(?:\/|$)|(?:^|\/)\.env$|\.(?:db|sqlite|pem|key|zip|tar|gz|png|jpg|jpeg|mp4|pdf)$/i.test(p)) return false;
  return /^(?:server\/(?:src|tests|assets)\/|webapp\/(?:src|public)\/|packs\/|tools\/|docs\/)|^(?:\.dockerignore|\.editorconfig|\.gitignore|\.env\.example|Dockerfile|compose\.yaml|package(?:-lock)?\.json|README\.md|THIRD-PARTY\.md)$/.test(p) || /^(server|webapp)\/(?:package\.json|tsconfig[^/]*\.json|vite\.config\.ts|vitest\.config\.ts|index\.html)$/.test(p);
}).sort();
const manifest = [];
for (const file of files) {
  const stat = lstatSync(file); if (!stat.isFile()) throw new Error(`Non-regular source file ${file}`);
  const bytes = readFileSync(file);
  // Heuristic is only a guard, never a certificate of no secrets. Explicit sensitive paths are excluded above.
  if (/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|\b(?:ghp_|github_pat_|xoxb-|sk-proj-)[A-Za-z0-9_-]{20,}/.test(bytes.toString('utf8'))) throw new Error(`Potential credential in ${file}; refusing archive`);
  manifest.push({ path: file, bytes: bytes.length, sha256: sha(bytes) });
}
const timestamp = new Date().toISOString();
const stamp = timestamp.replace(/[-:.]/g, '').slice(0, 15);
const archive = `source-review-${stamp}.zip`;
await new Promise((done, fail) => {
  const child = spawn('/usr/bin/zip', ['-q', '-9', resolve(artifactDir, archive), '-@'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (v) => { stderr += v; }); child.on('error', fail);
  child.on('close', (code) => code === 0 ? done() : fail(new Error(`zip exit ${code}: ${stderr}`)));
  child.stdin.end(files.join('\n') + '\n');
});
const archiveBytes = readFileSync(resolve(artifactDir, archive));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--short'], { encoding: 'utf8' });
writeFileSync(resolve(artifactDir, 'SOURCE_REVIEW_MANIFEST.json'), JSON.stringify({ timestamp, baseCommit: head, dirty: true, archive, archiveBytes: archiveBytes.length, archiveSha256: sha(archiveBytes), fileCount: manifest.length, sourceLogicalBytes: manifest.reduce((n, f) => n + f.bytes, 0), included: manifest, excluded: ['.env and live databases', 'SSH/StackHawk credentials', 'node_modules/.venv/cache', 'research screenshots and bulky binaries', 'Git internals'], warning: 'Review source snapshot, not final competition submission. API/deployment and Linux reproduction checks remain. Secret detection is heuristic; inspect before external transfer.' }, null, 2));
writeFileSync(resolve(artifactDir, 'WORKTREE_STATUS.txt'), dirty);
writeFileSync(resolve(artifactDir, 'TRACKED_CHANGES.patch'), execFileSync('git', ['diff', '--binary', '--', ...files.filter((f) => !f.startsWith('docs/'))]));
console.log(JSON.stringify({ baseCommit: head, dirty: true, files: manifest.length, archive, bytes: archiveBytes.length, sha256: sha(archiveBytes) }, null, 2));
