/**
 * Фоновые задачи без внешней очереди: сторож вебхука, прогрев кэша демо-запросов,
 * еженедельная проверка подписок, загрузка плана проверок ЕРКНМ, очистка таблицы идемпотентности.
 */
import type { Bot } from '@maxhub/max-bot-api';
import type { Db } from '../db/index.js';
import { getUser, listActiveSubscriptions, pruneUpdatesSeen, touchSubscription } from '../db/index.js';
import { isCustomProfessionKey, resolveProfession, selectPack } from '../packs/loader.js';
import { buildMarket, type MarketContext } from '../services/market.js';
import { describeSyncError, needsSync, syncInspections } from '../services/inspections.js';
import { formatRub } from '../core/index.js';
import { ensureSubscription, type UpdatesDeps } from '../bot/updates.js';
import { openRadarButton } from '../services/report.js';
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
        await buildMarket(deps.market, { professionKey: pack.demo.profession, regionFnsCode: pack.region.fnsCode, inn: pack.demo.inn, offer: pack.demo.salary, maxUserId: null, forceRefresh: true });
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
        // Своя должность («custom:…») живёт только текстом в состоянии пользователя: без него подписку не пересчитать — помечаем проверенной, чтобы не долбить источник каждый час.
        let profession;
        if (isCustomProfessionKey(s.professionKey)) {
          const text = (getUser(deps.db, s.maxUserId)?.state as { professionTexts?: Record<string, string> } | undefined)?.professionTexts?.[s.professionKey];
          const pack = selectPack(deps.market.catalog, { fnsRegionCode: region?.fnsCode ?? null, okved: null });
          profession = text ? resolveProfession(deps.market.catalog, pack, text) ?? undefined : undefined;
          if (!profession) { touchSubscription(deps.db, s.id, s.lastMedian); continue; }
        }
        const result = await buildMarket(deps.market, { professionKey: s.professionKey, profession, regionFnsCode: region?.fnsCode ?? null, inn: null, offer: s.offer, maxUserId: s.maxUserId, forceRefresh: true });
        const median = result.card.stats?.median ?? null;
        const prev = s.lastMedian;
        touchSubscription(deps.db, s.id, median);
        if (median != null && prev != null && Math.abs(median - prev) / prev >= 0.05) {
          const dir = median > prev ? 'выросла' : 'снизилась';
          await deps.bot.api.sendMessageToChat(s.chatId, `📈 Рынок сдвинулся: медиана «${result.profession.title}, ${result.region.name}» ${dir} с ${formatRub(prev)} до ${formatRub(median)}${s.offer ? `; ваша ставка ${formatRub(s.offer)} теперь — ${result.card.offer?.percentile}-й перцентиль` : ''}.`, {
            attachments: [Keyboard.inlineKeyboard([[openRadarButton(deps.botUsername, result.cardId)]])],
          });
        }
      } catch (err) { deps.log.warn({ sub: s.id, err: String(err) }, 'subscription check failed'); }
    }
  }));

  // План проверок ЕРКНМ: первая загрузка фоном (старт сервера не ждёт 39 МБ архива).
  // Дальше задача просыпается раз в час, но к источнику идёт, только когда набор не подтверждали
  // больше ERKNM_MAX_AGE_DAYS (по умолчанию 7 дней) — то есть проверка версии раз в неделю.
  // Часовой шаг нужен для повтора: если сайт реестра недоступен, следующая попытка будет через час, а не через неделю.
  const syncChecks = async () => {
    if (!needsSync(deps.market)) return;
    try {
      const r = await syncInspections(deps.market);
      if (r.status === 'loaded') deps.log.info({ version: r.dataset?.version, records: r.dataset?.records, withRegion: r.dataset?.withRegion }, 'erknm: план проверок обновлён');
    } catch (err) {
      deps.log.warn({ err: describeSyncError(err) }, 'erknm: не удалось обновить план проверок — сервис отвечает по последнему загруженному набору');
    }
  };
  setTimeout(() => { void syncChecks(); }, 20_000).unref();
  timers.push(every(60 * 60_000, syncChecks));

  timers.push(every(6 * 3600_000, async () => { pruneUpdatesSeen(deps.db, new Date(Date.now() - 3 * 86400_000).toISOString()); }));

  return () => timers.forEach((t) => clearInterval(t));
}
