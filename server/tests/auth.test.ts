import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildSignedInitData, computeInitDataHash, signSession, validateInitData, verifySession } from '../src/api/auth.js';

const TOKEN = 'test-bot-token-123';

describe('initData validation (official MAX algorithm)', () => {
  it('matches the reference computation: secret = HMAC("WebAppData", token); hash = HMAC(secret, sorted launch params)', () => {
    const pairs: [string, string][] = [['user', '{"id":67890,"first_name":"Max"}'], ['auth_date', '1771409719'], ['query_id', 'q1']];
    const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const expected = createHmac('sha256', secret).update('auth_date=1771409719\nquery_id=q1\nuser={"id":67890,"first_name":"Max"}').digest('hex');
    expect(computeInitDataHash(TOKEN, pairs)).toBe(expected);
  });
  it('accepts a correctly signed payload and parses user/chat/start_param', () => {
    const now = 1771409719;
    const initData = buildSignedInitData(TOKEN, { auth_date: String(now), chat: '{"id":12345,"type":"DIALOG"}', query_id: '4c0ab423', user: '{"id":67890,"first_name":"Max","username":"max"}', start_param: 'card_abc' });
    const r = validateInitData(initData, TOKEN, { now });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.user?.id).toBe(67890);
      expect(r.data.chat?.type).toBe('DIALOG');
      expect(r.data.startParam).toBe('card_abc');
    }
  });
  it('rejects tampering, missing/duplicate hash, wrong token and stale auth_date', () => {
    const now = 1771409719;
    const good = buildSignedInitData(TOKEN, { auth_date: String(now), user: '{"id":1}' });
    expect(validateInitData(good.replace('%22id%22%3A1', '%22id%22%3A2'), TOKEN, { now })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(validateInitData(good, 'other-token', { now })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(validateInitData(good.replace(/&hash=[^&]+/, ''), TOKEN, { now })).toEqual({ ok: false, reason: 'no_hash' });
    expect(validateInitData(`${good}&hash=deadbeef`, TOKEN, { now })).toEqual({ ok: false, reason: 'no_hash' });
    expect(validateInitData(good, TOKEN, { now: now + 7200 })).toEqual({ ok: false, reason: 'expired' });
    expect(validateInitData('', TOKEN)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('sessions', () => {
  it('round-trips and rejects forged or expired tokens', () => {
    const now = 1_800_000_000;
    const t = signSession('s3cret', { uid: 42, name: 'Валерий', chatId: 7, demo: false, exp: now + 60 });
    expect(verifySession('s3cret', t, now)?.uid).toBe(42);
    expect(verifySession('other', t, now)).toBeNull();
    expect(verifySession('s3cret', `${t}x`, now)).toBeNull();
    expect(verifySession('s3cret', t, now + 120)).toBeNull();
  });
});
