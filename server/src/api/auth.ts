/**
 * Проверка подлинности данных запуска мини-приложения (initData) по официальному алгоритму MAX:
 *   secret_key = HMAC_SHA256(key = "WebAppData", msg = BOT_TOKEN)
 *   hash       = hex(HMAC_SHA256(key = secret_key, msg = "k1=v1\nk2=v2…" по ключам a→z, без hash))
 * Сессия мини-приложения — подписанный токен (HMAC) с MAX user id и сроком жизни.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface InitDataUser { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string; photo_url?: string }
export interface InitDataChat { id: number; type: 'DIALOG' | 'CHAT' | 'CHANNEL' }
export interface ParsedInitData {
  queryId: string | null;
  authDate: number;
  user: InitDataUser | null;
  chat: InitDataChat | null;
  startParam: string | null;
  ip: string | null;
}

export type InitDataResult = { ok: true; data: ParsedInitData } | { ok: false; reason: 'malformed' | 'no_hash' | 'bad_signature' | 'expired' };

export function computeInitDataHash(botToken: string, pairs: [string, string][]): string {
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const launchParams = [...pairs].filter(([k]) => k !== 'hash').sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  return createHmac('sha256', secretKey).update(launchParams).digest('hex');
}

/** initData — строка `WebAppData` из фрагмента URL (как отдаёт window.WebApp.initData). */
export function validateInitData(initData: string, botToken: string, opts: { maxAgeSec?: number; now?: number } = {}): InitDataResult {
  if (!initData || typeof initData !== 'string' || initData.length > 8192) return { ok: false, reason: 'malformed' };
  const pairs: [string, string][] = [];
  for (const part of initData.split('&')) {
    if (!part) continue;
    const idx = part.indexOf('=');
    const k = idx === -1 ? part : part.slice(0, idx);
    const raw = idx === -1 ? '' : part.slice(idx + 1);
    let v: string;
    try { v = decodeURIComponent(raw); } catch { return { ok: false, reason: 'malformed' }; }
    pairs.push([k, v]);
  }
  const hashes = pairs.filter(([k]) => k === 'hash');
  if (hashes.length !== 1) return { ok: false, reason: 'no_hash' };
  const given = hashes[0]![1];
  const expected = computeInitDataHash(botToken, pairs);
  const a = Buffer.from(given, 'utf8'); const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  const get = (k: string) => pairs.find(([kk]) => kk === k)?.[1] ?? null;
  const authDate = Number(get('auth_date'));
  if (!Number.isFinite(authDate)) return { ok: false, reason: 'malformed' };
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const maxAge = opts.maxAgeSec ?? 3600;
  if (Math.abs(now - authDate) > maxAge) return { ok: false, reason: 'expired' };
  const parseJson = <T>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };
  return {
    ok: true,
    data: { queryId: get('query_id'), authDate, user: parseJson<InitDataUser>(get('user')), chat: parseJson<InitDataChat>(get('chat')), startParam: get('start_param'), ip: get('ip') },
  };
}

/** Тестовая утилита: собрать подписанную initData (для тестов и локальной отладки). */
export function buildSignedInitData(botToken: string, fields: Record<string, string>): string {
  const pairs = Object.entries(fields) as [string, string][];
  const hash = computeInitDataHash(botToken, pairs);
  return [...pairs, ['hash', hash] as [string, string]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/* ---------- сессии мини-приложения ---------- */
export interface SessionPayload { uid: number; name: string | null; chatId: number | null; demo: boolean; exp: number }

function b64url(buf: Buffer): string { return buf.toString('base64url'); }

export function signSession(secret: string, payload: SessionPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(secret: string, token: string | undefined, now = Math.floor(Date.now() / 1000)): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof p.uid !== 'number' || typeof p.exp !== 'number' || p.exp < now) return null;
    return p;
  } catch { return null; }
}
