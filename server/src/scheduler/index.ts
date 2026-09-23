/**
 * Фоновые задачи без внешней очереди: сторож вебхука, прогрев кэша демо-запросов,
 * еженедельная проверка подписок, очистка таблицы идемпотентности.
 */
import type { Bot } from '@maxhub/max-bot-api';
import type { Db } from '../db/index.js';
import { listActiveSubscriptions, pruneUpdatesSeen, touchSubscription } from '../db/index.js';
import { buildMarket, type MarketContext } from '../services/market.js';
import { formatRub } from '../core/index.js';
import { ensureSubscription, type UpdatesDeps } from '../bot/updates.js';
import { cardDeepLink } from '../services/report.js';
import { Keyboard } from '@maxhub/max-bot-api';

export interface SchedulerDeps {
  db: Db;
  market: MarketContext;
  bot: Bot | null;
  botUsername: string | null;
  updates: UpdatesDeps | null;
  webhook: { url: string; secret: string | null } | null;
  log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

const every = (ms: number, fn: () => Promise<void>) => {
  const t = setInterval(() => { void fn().catch(() => undefined); }, ms);
  t.unref();
  return t;
};

export function startScheduler(deps: SchedulerDeps): () => void {
  const timers: NodeJS.Timeout[] = [];

  // Сторож вебхука: MAX отписывает бота после 8 часов без ответа 200 — проверяем каждые 10 минут.
  if (deps.updates && deps.webhook) {
    const { url, secret } = deps.webhook;
    timers.push(every(10 * 60_000, async () => { await ensureSubscription(deps.updates!, url, secret); }));
  }

  // Прогрев кэша для демо-пар из пакетов, чтобы первая карточка у жюри открывалась мгновенно.
  const warm = async () => {
    for (const pack of deps.market.catalog.packs) {
      if (!pack.demo || !pack.region) continue;
      try {
        await buildMarket(deps.market, { professionKey: pack.demo.profession, regionFnsCode: pack.region.fnsCode, inn: pack.demo.inn, offer: pack.demo.salary, maxUserId: null });
        deps.log.info({ pack: pack.id }, 'warm cache ok');
      } catch (err) { deps.log.warn({ pack: pack.id, err: String(err) }, 'warm cache failed'); }
    }
  };
  setTimeout(() => { void warm(); }, 15_000).unref();
  timers.push(every(5 * 3600_000, warm));

  // Подписки: раз в час смотрим, кому пора пересчитать (7 дней с последней проверки).
  timers.push(every(60 * 60_000, async () => {
    if (!deps.bot || !deps.botUsername) return;
    const now = Date.now();
    for (const s of listActiveSubscriptions(deps.db)) {
      const last = s.lastCheckedAt ? Date.parse(s.lastCheckedAt) : 0;
      if (now - last < 7 * 86400_000) continue;
      try {
        const region = deps.market.catalog.regions.find((r) => r.code === s.regionCode);
        const result = await buildMarket(deps.market, { professionKey: s.professionKey, regionFnsCode: region?.fnsCode ?? null, inn: null, offer: s.offer, maxUserId: s.maxUserId, forceRefresh: true });
        const median = result.card.stats?.median ?? null;
        const prev = s.lastMedian;
        touchSubscription(deps.db, s.id, median);
        if (median != null && prev != null && Math.abs(median - prev) / prev >= 0.05) {
          const dir = median > prev ? 'выросла' : 'снизилась';
          await deps.bot.api.sendMessageToChat(s.chatId, `📈 Рынок сдвинулся: медиана «${result.profession.title}, ${result.region.name}» ${dir} с ${formatRub(prev)} до ${formatRub(median)}${s.offer ? `; ваша ставка ${formatRub(s.offer)} теперь — ${result.card.offer?.percentile}-й перцентиль` : ''}.`, {
            attachments: [Keyboard.inlineKeyboard([[Keyboard.button.link('Открыть радар', cardDeepLink(deps.botUsername, result.cardId))]])],
          });
        }
      } catch (err) { deps.log.warn({ sub: s.id, err: String(err) }, 'subscription check failed'); }
    }
  }));

  timers.push(every(6 * 3600_000, async () => { pruneUpdatesSeen(deps.db, new Date(Date.now() - 3 * 86400_000).toISOString()); }));

  return () => timers.forEach((t) => clearInterval(t));
}
