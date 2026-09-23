import { describe, expect, it } from 'vitest';
import { openDb, upsertUser, updateUser, getUser, putCard, getCard, markUpdateSeen, castVote, upsertSubscription, listActiveSubscriptions, deactivateSubscription, recordVacancySeen, closureStats, putVacancyCache, getVacancyCache } from '../src/db/index.js';

describe('db', () => {
  const db = openDb(':memory:');
  it('stores users with state', () => {
    upsertUser(db, { maxUserId: 1, name: 'Тест', chatId: 10 });
    updateUser(db, 1, { inn: '7801633015', state: { step: 'profession' } });
    const u = getUser(db, 1)!;
    expect(u.inn).toBe('7801633015');
    expect(u.state).toEqual({ step: 'profession' });
    expect(u.chatId).toBe(10);
  });
  it('stores cards and dedupes webhook updates', () => {
    putCard(db, { id: 'c1', maxUserId: 1, inn: null, packId: 'generic', professionKey: 'povar', regionCode: '78', offer: 45000, payload: { a: 1 } });
    expect(getCard<{ a: number }>(db, 'c1')!.payload.a).toBe(1);
    expect(markUpdateSeen(db, 'message_created:1')).toBe(true);
    expect(markUpdateSeen(db, 'message_created:1')).toBe(false);
  });
  it('counts votes per message and manages subscriptions', () => {
    castVote(db, 'mid1', 1, 'median');
    castVote(db, 'mid1', 2, 'median');
    const v = castVote(db, 'mid1', 1, 'top');
    expect(v.total).toBe(2);
    expect(v.counts).toEqual({ median: 1, top: 1 });
    const s = upsertSubscription(db, { id: 's1', maxUserId: 1, chatId: 10, packId: 'generic', professionKey: 'povar', regionCode: '78', offer: 45000, lastMedian: 69000 });
    expect(s.active).toBe(true);
    expect(listActiveSubscriptions(db).length).toBe(1);
    expect(deactivateSubscription(db, 's1', 1)).toBe(true);
    expect(listActiveSubscriptions(db).length).toBe(0);
  });
  it('tracks vacancy closures above and below the median', () => {
    recordVacancySeen(db, '78', 'povar', [{ id: 'v1', employerInn: '1', value: 50000 }, { id: 'v2', employerInn: '2', value: 90000 }], '2026-09-20T00:00:00.000Z');
    recordVacancySeen(db, '78', 'povar', [{ id: 'v2', employerInn: '2', value: 90000 }], '2026-09-27T00:00:00.000Z');
    const c = closureStats(db, '78', 'povar', 70000, '2026-09-27T00:00:00.000Z')!;
    expect(c.observedDays).toBe(7);
    expect(c.closedBelow).toBe(1);
    expect(c.closedAbove).toBe(0);
  });
  it('caches vacancy payloads', () => {
    putVacancyCache(db, { cacheKey: 'k', regionCode: '78', query: 'повар', total: 5, payload: [{ id: 'x' }], fetchedAt: '2026-09-23T00:00:00Z' });
    expect(getVacancyCache<{ id: string }[]>(db, 'k')!.payload[0]!.id).toBe('x');
  });
});
