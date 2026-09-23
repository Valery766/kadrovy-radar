/**
 * Сценарий бота: короткий диалог «ИНН → должность → ставка → карточка».
 * Состояние пользователя хранится в БД (users.state), поэтому переживает перезапуск.
 */
import type { Bot, Context } from '@maxhub/max-bot-api';
import { Keyboard } from '@maxhub/max-bot-api';
import type { Db } from '../db/index.js';
import { castVote, deactivateSubscription, getCard, getUser, listUserSubscriptions, updateUser, upsertUser, upsertSubscription } from '../db/index.js';
import { buildMarket, getProfile, MarketError, type MarketContext, type MarketResult } from '../services/market.js';
import { sendReportToChat, type ReportContext } from '../services/report.js';
import { buildVacancyDraft, formatRub, normalizeText, type Pack } from '../core/index.js';
import { isValidInn } from '../integrations/rmsp.js';
import { regionByFnsCode, selectPack, type PackCatalog } from '../packs/loader.js';
import * as T from './texts.js';
import { randomUUID } from 'node:crypto';

export interface BotDeps {
  db: Db;
  market: MarketContext;
  report: ReportContext;
  catalog: PackCatalog;
  appUrl: string;
  botUsername: string;
  log: { info: (o: object, msg?: string) => void; warn: (o: object, msg?: string) => void; error: (o: object, msg?: string) => void };
}

type Step = 'idle' | 'inn' | 'region' | 'profession' | 'salary';
interface State { step?: Step; professionKey?: string; regionFnsCode?: string | null; lastCardId?: string }

const COMMANDS = [
  { name: 'start', description: 'Начать' },
  { name: 'stavka', description: 'Проверить ставку по должности' },
  { name: 'profile', description: 'Указать ИНН бизнеса' },
  { name: 'demo', description: 'Показать на примере' },
  { name: 'subs', description: 'Мои подписки на рынок' },
  { name: 'help', description: 'Как это работает' },
];

export function findRegion(catalog: PackCatalog, text: string) {
  const t = normalizeText(text);
  if (!t) return null;
  const exact = catalog.regions.find((r) => normalizeText(r.name) === t);
  if (exact) return exact;
  const alias: Record<string, string> = { спб: '78', питер: '78', петербург: '78', москва: '77', мск: '77', казань: '16', татарстан: '16', екатеринбург: '66', новосибирск: '54' };
  for (const [k, code] of Object.entries(alias)) if (t === k || t.includes(k)) return catalog.regions.find((r) => r.fnsCode === code) ?? null;
  if (t.length < 4) return null;
  const STOP = new Set(['область', 'край', 'республика', 'округ', 'автономный', 'город']);
  const words = t.split(' ').filter((w) => w.length >= 4 && !STOP.has(w));
  if (!words.length) return null;
  const hits = catalog.regions.filter((r) => { const n = normalizeText(r.name); return words.every((w) => n.includes(w)); });
  return hits.length === 1 ? hits[0]! : null;
}

export function findProfession(catalog: PackCatalog, pack: Pack, text: string) {
  const t = normalizeText(text);
  if (!t) return null;
  const pool = [...pack.professions, ...catalog.professions.filter((p) => !pack.professions.some((x) => x.key === p.key))];
  return pool.find((p) => normalizeText(p.title) === t || p.synonyms.some((s) => t === normalizeText(s)))
    ?? pool.find((p) => p.synonyms.some((s) => t.includes(normalizeText(s))) && !p.exclude.some((e) => t.includes(normalizeText(e))))
    ?? null;
}

function parseSalary(text: string): number | null | 'none' {
  const t = normalizeText(text);
  if (/^(нет|без|пропустить|-)$/.test(t)) return 'none';
  const cleaned = t.replace(/[^\d.,к k тыс]/g, '');
  const m = /(\d+(?:[.,]\d+)?)/.exec(t.replace(/\s/g, ''));
  if (!m) return null;
  let n = Number(m[1]!.replace(',', '.'));
  if (/(тыс|т\.?р|к\b|k\b)/.test(t) || (n < 1000 && cleaned)) n *= 1000;
  if (!Number.isFinite(n) || n < 1000 || n > 5_000_000) return null;
  return Math.round(n);
}

export function registerBot(bot: Bot, deps: BotDeps): void {
  const { db, catalog, log } = deps;

  const setState = (uid: number, patch: State) => {
    const u = getUser(db, uid);
    updateUser(db, uid, { state: { ...(u?.state as State ?? {}), ...patch } });
  };
  const state = (uid: number): State => (getUser(db, uid)?.state as State) ?? {};

  const ensureUser = (ctx: Context) => {
    const u = ctx.user;
    const uid = u?.user_id ?? 0;
    if (!uid) return null;
    const msg = ctx.message as { recipient?: { chat_type?: string } } | undefined;
    const isDialog = msg?.recipient?.chat_type ? msg.recipient.chat_type === 'dialog' : ctx.updateType === 'bot_started';
    return upsertUser(db, { maxUserId: uid, name: u?.first_name ?? null, username: u?.username ?? null, chatId: isDialog ? (ctx.chatId ?? null) : null });
  };

  const packFor = (uid: number): Pack => {
    const u = getUser(db, uid);
    const okved = u?.inn ? (db.prepare('SELECT payload FROM business_profiles WHERE inn = ?').get(u.inn) as { payload: string } | undefined) : undefined;
    const prof = okved ? (JSON.parse(okved.payload) as { okved: string | null }) : null;
    return selectPack(catalog, { fnsRegionCode: u?.regionFnsCode ?? null, okved: prof?.okved ?? null });
  };

  async function startFlow(ctx: Context, uid: number) {
    const u = getUser(db, uid);
    if (u?.inn && u.regionFnsCode) {
      setState(uid, { step: 'profession' });
      const pack = packFor(uid);
      await ctx.reply(T.askProfessionText(pack), { attachments: [T.professionKeyboard(pack)] });
    } else {
      setState(uid, { step: 'inn' });
      await ctx.reply(T.askInnText());
    }
  }

  async function handleInn(ctx: Context, uid: number, inn: string) {
    if (!isValidInn(inn)) {
      await ctx.reply('Похоже, это не ИНН: нужно 10 или 12 цифр с верной контрольной суммой. Попробуйте ещё раз или напишите «пропустить».');
      return;
    }
    await ctx.api.sendAction(ctx.chatId!, 'typing_on').catch(() => undefined);
    try {
      const profile = await getProfile(deps.market, inn);
      updateUser(db, uid, { inn, regionFnsCode: profile.fnsRegionCode ?? undefined });
      const region = regionByFnsCode(catalog, profile.fnsRegionCode);
      const pack = selectPack(catalog, { fnsRegionCode: profile.fnsRegionCode, okved: profile.okved });
      updateUser(db, uid, { packId: pack.id });
      if (!profile.inRegistry || !region) {
        setState(uid, { step: 'region' });
        await ctx.reply(T.profileText(profile, pack, region?.name ?? null));
        return;
      }
      setState(uid, { step: 'idle' });
      await ctx.reply(T.profileText(profile, pack, region.name), { attachments: [T.profileKeyboard()] });
    } catch (err) {
      log.warn({ err: String(err) }, 'profile lookup failed');
      await ctx.reply(`Не удалось получить профиль: ${err instanceof MarketError ? err.message : 'источник временно недоступен'}. Попробуйте позже или напишите «пропустить».`);
    }
  }

  async function runMarket(ctx: Context, uid: number, offer: number | null, override?: { inn: string | null; regionFnsCode: string | null; professionKey: string }) {
    const st = state(uid);
    const u = getUser(db, uid)!;
    const professionKey = override?.professionKey ?? st.professionKey;
    if (!professionKey) { await startFlow(ctx, uid); return; }
    if (!override && !u.regionFnsCode && !u.inn) { setState(uid, { step: 'region' }); await ctx.reply('Сначала регион: напишите его название (например, «Санкт-Петербург») или укажите ИНН через /profile.'); return; }
    await ctx.api.sendAction(ctx.chatId!, 'typing_on').catch(() => undefined);
    const waiting = await ctx.reply('Считаю: запрашиваю вакансии на «Работе России» и сверяю работодателей с реестром МСП. Обычно это 10–40 секунд…');
    try {
      const result = await buildMarket(deps.market, { professionKey, regionFnsCode: override ? override.regionFnsCode : (u.regionFnsCode ?? null), inn: override ? override.inn : (u.inn ?? null), offer, maxUserId: uid });
      setState(uid, { step: 'idle', lastCardId: result.cardId });
      await ctx.api.editMessage(waiting.body.mid, { text: T.cardText(result), attachments: [T.cardKeyboard(result, deps.botUsername)] }).catch(async () => {
        await ctx.reply(T.cardText(result), { attachments: [T.cardKeyboard(result, deps.botUsername)] });
      });
    } catch (err) {
      const msg = err instanceof MarketError ? err.message : 'что-то пошло не так';
      log.error({ err: String(err) }, 'market failed');
      setState(uid, { step: 'idle' });
      await ctx.reply(`Не получилось: ${msg}. Нажмите «Повторить» или начните заново командой /stavka.`, { attachments: [Keyboard.inlineKeyboard([[Keyboard.button.callback('Повторить', `retry:${offer ?? 'none'}`)]])] });
    }
  }

  async function sendCardById(ctx: Context, uid: number, cardId: string) {
    const row = getCard<MarketResult>(db, cardId);
    if (!row) { await ctx.reply('Такой карточки нет — возможно, ссылка устарела. Начните заново: /stavka'); return; }
    await ctx.reply(T.cardText(row.payload), { attachments: [T.cardKeyboard(row.payload, deps.botUsername)] });
    setState(uid, { lastCardId: cardId });
  }

  bot.on('bot_started', async (ctx) => {
    const u = ensureUser(ctx);
    if (!u) return;
    const payload = ctx.startPayload;
    if (payload && payload.startsWith('card_')) { await sendCardById(ctx, u.maxUserId, payload.slice(5)); return; }
    await ctx.reply(T.welcomeText(u.name), { attachments: [T.welcomeKeyboard(deps.botUsername)] });
  });

  bot.on('bot_added', async (ctx) => {
    await ctx.reply('Привет! Я «Ставка» — зарплатный радар. Напишите /stavka, чтобы проверить ставку по должности.').catch(() => undefined);
  });

  bot.on('message_callback', async (ctx) => {
    const u = ensureUser(ctx);
    if (!u) return;
    const uid = u.maxUserId;
    const payload = ctx.callback?.payload ?? '';
    const cbId = ctx.callback?.callback_id;
    const ack = (notification?: string) => (cbId ? ctx.api.answerOnCallback(cbId, notification ? ({ notification } as never) : {}).catch(() => undefined) : Promise.resolve());

    if (payload === 'inn:new') { await ack(); setState(uid, { step: 'inn' }); await ctx.reply(T.askInnText()); return; }
    if (payload === 'profile:ok') { await ack(); setState(uid, { step: 'profession' }); const pack = packFor(uid); await ctx.reply(T.askProfessionText(pack), { attachments: [T.professionKeyboard(pack)] }); return; }
    if (payload === 'demo') {
      await ack();
      const demos = catalog.packs.filter((p) => p.demo);
      if (demos.length <= 1) { await runDemo(ctx, uid, demos[0]?.id); return; }
      await ctx.reply('Какой пример показать? Разные регионы и отрасли считаются одним и тем же кодом — меняется только пакет контекста.', { attachments: [Keyboard.inlineKeyboard(demos.map((p) => [Keyboard.button.callback(p.title, `demo:${p.id}`)]))] });
      return;
    }
    if (payload.startsWith('demo:')) { await ack(); await runDemo(ctx, uid, payload.slice(5)); return; }
    if (payload === 'prof:again') { await ack(); setState(uid, { step: 'profession' }); const pack = packFor(uid); await ctx.reply(T.askProfessionText(pack), { attachments: [T.professionKeyboard(pack)] }); return; }
    if (payload.startsWith('prof:')) {
      await ack();
      const key = payload.slice(5);
      const pack = packFor(uid);
      const prof = pack.professions.find((p) => p.key === key) ?? catalog.professions.find((p) => p.key === key);
      if (!prof) { await ctx.reply('Не нашёл такую должность. Выберите из списка или напишите текстом.'); return; }
      setState(uid, { step: 'salary', professionKey: prof.key });
      await ctx.reply(T.askSalaryText(prof.title));
      return;
    }
    if (payload.startsWith('retry:')) { await ack(); const v = payload.slice(6); await runMarket(ctx, uid, v === 'none' ? null : Number(v)); return; }
    if (payload.startsWith('vote:')) {
      const [, kind, cardId] = payload.split(':');
      const row = cardId ? getCard<MarketResult>(db, cardId) : null;
      if (!row || !kind) { await ack('Карточка не найдена'); return; }
      const mid = ctx.messageId ?? `card:${cardId}`;
      const tally = castVote(db, mid, uid, kind);
      const opt = row.payload.card.options.find((o) => o.kind === kind);
      const summary = row.payload.card.options.map((o) => `${o.kind === 'keep' ? 'оставить' : o.kind === 'median' ? 'медиана' : 'топ-25 %'} ${formatRub(o.value)}: ${tally.counts[o.kind] ?? 0}`).join(' · ');
      await ack(opt ? `Ваш выбор: ${formatRub(opt.value)}` : 'Голос учтён');
      await ctx.reply(`Голосование по ставке «${row.payload.profession.title}»: ${summary}. Всего голосов: ${tally.total}.`);
      return;
    }
    if (payload.startsWith('pdf:')) {
      const cardId = payload.slice(4);
      const row = getCard<MarketResult>(db, cardId);
      if (!row) { await ack('Карточка не найдена'); return; }
      await ack('Готовлю PDF…');
      await ctx.api.sendAction(ctx.chatId!, 'sending_file').catch(() => undefined);
      try {
        const r = await sendReportToChat(deps.report, row.payload, uid, ctx.chatId!);
        if (r.reused) await ctx.reply('Отчёт по этой карточке уже есть в чате выше (отправлен недавно). Переслать его можно из радара — «Поделиться в MAX».');
      } catch (err) {
        log.error({ err: String(err) }, 'report failed');
        await ctx.reply('Не удалось отправить отчёт. Попробуйте ещё раз через минуту.');
      }
      return;
    }
    if (payload.startsWith('sub:')) {
      const cardId = payload.slice(4);
      const row = getCard<MarketResult>(db, cardId);
      if (!row) { await ack('Карточка не найдена'); return; }
      const r = row.payload;
      upsertSubscription(db, { id: randomUUID(), maxUserId: uid, chatId: ctx.chatId!, packId: r.pack.id, professionKey: r.profession.key, regionCode: r.region.code, offer: r.card.offer?.value ?? null, lastMedian: r.card.stats?.median ?? null });
      await ack('Подписка оформлена');
      await ctx.reply(`Буду раз в неделю пересчитывать рынок «${r.profession.title}, ${r.region.name}» и писать, если медиана сдвинется больше чем на 5 %. Отписаться: /subs`);
      return;
    }
    if (payload.startsWith('unsub:')) {
      const ok = deactivateSubscription(db, payload.slice(6), uid);
      await ack(ok ? 'Подписка отключена' : 'Подписка не найдена');
      return;
    }
    if (payload.startsWith('text:')) {
      const cardId = payload.slice(5);
      const row = getCard<MarketResult>(db, cardId);
      if (!row) { await ack('Карточка не найдена'); return; }
      await ack();
      const r = row.payload;
      const pack = catalog.packs.find((p) => p.id === r.pack.id)!;
      const salary = r.card.options.find((o) => o.kind === 'median')?.value ?? r.card.offer?.value ?? r.card.stats?.median ?? 0;
      const text = buildVacancyDraft({ card: r.card, profession: r.profession, pack, salary, companyName: r.profile?.name ?? null, cityName: r.region.name });
      await ctx.reply(`Черновик вакансии (собран из частых формулировок рынка, ставка — медиана):\n\n${text}`);
      return;
    }
    await ack();
  });

  async function runDemo(ctx: Context, uid: number, packId?: string) {
    const pack = (packId ? catalog.packs.find((p) => p.id === packId && p.demo) : null) ?? catalog.packs.find((p) => p.demo) ?? null;
    if (!pack?.demo) { await ctx.reply('Демо-пример не настроен.'); return; }
    await ctx.reply(`Пример: ${pack.demo.note ?? pack.demo.inn}. Должность — «${pack.professions.find((p) => p.key === pack.demo!.profession)?.title}», ставка ${formatRub(pack.demo.salary)}. Ваш собственный профиль не меняется.`);
    await runMarket(ctx, uid, pack.demo.salary, { inn: pack.demo.inn, regionFnsCode: pack.region?.fnsCode ?? null, professionKey: pack.demo.profession });
  }

  bot.on('message_created', async (ctx) => {
    const u = ensureUser(ctx);
    if (!u) return;
    const uid = u.maxUserId;
    const text = (ctx.message?.body?.text ?? '').trim();
    if (!text) return;
    const cmd = /^\/(\w+)/.exec(text)?.[1]?.toLowerCase();
    if (cmd === 'start') { await ctx.reply(T.welcomeText(u.name), { attachments: [T.welcomeKeyboard(deps.botUsername)] }); return; }
    if (cmd === 'help') { await ctx.reply(T.helpText()); return; }
    if (cmd === 'demo') {
      const demos = catalog.packs.filter((p) => p.demo);
      if (demos.length <= 1) { await runDemo(ctx, uid, demos[0]?.id); return; }
      await ctx.reply('Какой пример показать? Разные регионы и отрасли считаются одним кодом — меняется только пакет контекста.', { attachments: [Keyboard.inlineKeyboard(demos.map((p) => [Keyboard.button.callback(p.title, `demo:${p.id}`)]))] });
      return;
    }
    if (cmd === 'profile') { setState(uid, { step: 'inn' }); await ctx.reply(T.askInnText()); return; }
    if (cmd === 'stavka') { await startFlow(ctx, uid); return; }
    if (cmd === 'subs') {
      const subs = listUserSubscriptions(db, uid);
      if (!subs.length) { await ctx.reply('Подписок пока нет. Их можно оформить из карточки рынка — кнопка «Следить за рынком».'); return; }
      const rows = subs.map((s) => [Keyboard.button.callback(`Отписаться: ${catalog.professions.find((p) => p.key === s.professionKey)?.title ?? s.professionKey}`, `unsub:${s.id}`)]);
      await ctx.reply(`Ваши подписки (${subs.length}): раз в неделю сравниваю медиану и пишу при сдвиге > 5 %.`, { attachments: [Keyboard.inlineKeyboard(rows)] });
      return;
    }

    const st = state(uid);
    switch (st.step) {
      case 'inn': {
        if (/^(пропустить|нет|skip)$/i.test(text)) { setState(uid, { step: 'region' }); await ctx.reply('Напишите регион, например «Санкт-Петербург» или «Татарстан».'); return; }
        await handleInn(ctx, uid, text.replace(/\D/g, ''));
        return;
      }
      case 'region': {
        const region = findRegion(catalog, text);
        if (!region) { await ctx.reply('Не узнал регион. Напишите название субъекта РФ, например «Московская область».'); return; }
        updateUser(db, uid, { regionFnsCode: region.fnsCode });
        setState(uid, { step: 'profession' });
        const pack = packFor(uid);
        await ctx.reply(`Регион: ${region.name}. ${T.askProfessionText(pack)}`, { attachments: [T.professionKeyboard(pack)] });
        return;
      }
      case 'profession': {
        const pack = packFor(uid);
        const prof = findProfession(catalog, pack, text);
        if (!prof) { await ctx.reply('Не нашёл такую должность в каталоге. Выберите кнопкой или попробуйте другое название (например, «повар», «продавец», «сварщик»).', { attachments: [T.professionKeyboard(pack)] }); return; }
        setState(uid, { step: 'salary', professionKey: prof.key });
        await ctx.reply(T.askSalaryText(prof.title));
        return;
      }
      case 'salary': {
        const s = parseSalary(text);
        if (s === null) { await ctx.reply('Не понял сумму. Напишите число в рублях в месяц, например 45000, или «нет».'); return; }
        await runMarket(ctx, uid, s === 'none' ? null : s);
        return;
      }
      default: {
        const inn = text.replace(/\D/g, '');
        if ((inn.length === 10 || inn.length === 12) && isValidInn(inn)) { await handleInn(ctx, uid, inn); return; }
        const pack = packFor(uid);
        const prof = findProfession(catalog, pack, text);
        if (prof && (getUser(db, uid)?.regionFnsCode)) { setState(uid, { step: 'salary', professionKey: prof.key }); await ctx.reply(T.askSalaryText(prof.title)); return; }
        await ctx.reply('Чтобы проверить ставку, нажмите /stavka. Справка: /help', { attachments: [T.welcomeKeyboard(deps.botUsername)] });
      }
    }
  });

  bot.catch((err, ctx) => {
    log.error({ err: String(err), update: ctx.update.update_type }, 'unhandled bot error');
  });

  void bot.api.setMyCommands(COMMANDS).catch((err) => log.warn({ err: String(err) }, 'setMyCommands failed'));
}
