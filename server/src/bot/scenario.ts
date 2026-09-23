/**
 * Сценарий бота: короткий диалог «ИНН → должность → ставка → карточка».
 * Состояние пользователя хранится в БД (users.state), поэтому переживает перезапуск.
 */
import type { Bot, Context } from '@maxhub/max-bot-api';
import { Keyboard } from '@maxhub/max-bot-api';
import type { CardRow, Db, VacancyRow } from '../db/index.js';
import { castVote, closeVacancy, deactivateSubscription, findResponseByCandidate, getCard, getUser, getVacancy, listResponsesByVacancy, listUserSubscriptions, listVacanciesByUser, putResponse, updateUser, upsertUser, upsertSubscription } from '../db/index.js';
import { buildMarket, getProfile, MarketError, type MarketContext, type MarketResult } from '../services/market.js';
import { buildStaffAssessment, MAX_STAFF_POSITIONS } from '../services/staff.js';
import { compareRegions } from '../services/regions.js';
import { MAX_DIGEST_PROFESSIONS, regionDigest } from '../services/region-digest.js';
import { inspectionsForBusiness, inspectionsProfileLine, inspectionsText } from '../services/inspections.js';
import { sendReportToChat, type ReportContext } from '../services/report.js';
import {
  createVacancyFromCard, EXPERIENCE_LABEL, inboxButton, phoneFromVcf, renderVacancyQr, responseSummary,
  scoreResponse, sendToUser, verifyContactSignature,
  type CandidateAnswers, type ExperienceKey, type HiringContext,
} from '../services/hiring.js';
import { buildVacancyDraft, formatRub, normalizeText, pluralRu, type Pack, type Profession } from '../core/index.js';
import { isValidInn } from '../integrations/rmsp.js';
import {
  isCustomProfessionKey, regionByFnsCode, resolveProfession, selectPack, suggestProfessions,
  type PackCatalog, type RegionInfo,
} from '../packs/loader.js';
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

type Step = 'idle' | 'inn' | 'region' | 'profession' | 'salary' | 'staff' | 'regions' | 'regions_prof'
  | 'apply_exp' | 'apply_schedule' | 'apply_salary' | 'apply_phone';
interface State {
  step?: Step;
  professionKey?: string;
  regionFnsCode?: string | null;
  lastCardId?: string;
  /** Тексты своих должностей по ключу «custom:<slug>»: из ключа текст не восстановить (это хеш). */
  professionTexts?: Record<string, string>;
  /** Собираемый список штата: строки «должность – ставка». */
  staffRows?: { title: string; salary: number }[];
  /** Должность, по которой идёт сравнение регионов. */
  regionsProfessionKey?: string;
  /** Что продолжить, когда пользователь назовёт регион. */
  pending?: 'staff' | 'digest';
  /** Кандидатский контур: вакансия, по которой идёт отклик, и накопленные ответы. */
  vacancyId?: string;
  answers?: Partial<CandidateAnswers>;
}

/**
 * Меню MAX: все команды на месте, но выстроены группами – сначала основное,
 * затем дополнительное, в конце настройки и справка. Описания короткие и
 * в словах владельца бизнеса, чтобы список читался сверху вниз.
 */
const COMMANDS = [
  { name: 'start', description: 'Начать: приветствие и что умеет бот' },
  // Основное
  { name: 'stavka', description: 'Сколько платить: проверить ставку' },
  { name: 'staff', description: 'Мой штат: кто получает меньше рынка' },
  { name: 'vacancies', description: 'Мои вакансии и отклики' },
  { name: 'checks', description: 'Плановые проверки по моему ИНН' },
  // Ещё
  { name: 'regions', description: 'Сравнить регионы по должности' },
  { name: 'digest', description: 'Зарплаты по всему моему региону' },
  { name: 'subs', description: 'Мои подписки: следить за рынком' },
  { name: 'demo', description: 'Показать на готовом примере' },
  // Настройки и справка
  { name: 'profile', description: 'Указать или сменить ИНН бизнеса' },
  { name: 'help', description: 'Что умеет бот и все команды' },
];

/** Сколько регионов сравниваем из чата: больше – и таблица не читается, и ждать дольше минуты. */
const BOT_MAX_REGIONS = 4;
/** Сколько профессий берём в сводку из чата (в API – до MAX_DIGEST_PROFESSIONS). */
const BOT_DIGEST_PROFESSIONS = Math.min(8, MAX_DIGEST_PROFESSIONS);
/** Ограничение MAX на длину сообщения. */
const MAX_MESSAGE_LENGTH = 4000;
/** Свободный текст должности режем, как в API (routes.ts): 120 символов. */
const MAX_PROFESSION_TEXT = 120;
/** Пауза между сообщениями: MAX принимает не больше двух сообщений в секунду на чат. */
const MESSAGE_PAUSE_MS = 600;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Режет длинный текст по границам строк, не разрывая сообщение посередине слова без нужды. */
export function splitText(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  const out: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    const pieces = line.length <= limit ? [line] : (line.match(new RegExp(`.{1,${limit}}`, 'gsu')) ?? [line]);
    for (const piece of pieces) {
      if (buf && buf.length + 1 + piece.length > limit) { out.push(buf); buf = piece; }
      else buf = buf ? `${buf}\n${piece}` : piece;
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : [''];
}

/**
 * Строка штата «повар 60000» → должность и ставка. Ставка – последнее число строки,
 * всё до него – название должности («повар 5 разряда – 60 тыс» тоже разбирается).
 */
/** Длиннее этого строка штата не бывает; регулярка ниже квадратична по длине, поэтому длинное отбрасываем сразу. */
const MAX_STAFF_LINE = 200;

export function parseStaffLine(line: string): { title: string; salary: number } | null {
  const t = line.trim().replace(/\s+/g, ' ');
  if (!t || t.length > MAX_STAFF_LINE) return null;
  const m = /^(.*?)[\s,;:—–-]*((?:\d[\d\s]*)(?:[.,]\d+)?\s*(?:тыс\.?|т\.?\s?р\.?|к|k)?)\s*(?:руб\.?|₽|р\.?)?$/iu.exec(t);
  if (!m) return null;
  const title = (m[1] ?? '').replace(/[,;:—–-]+$/u, '').trim();
  const salary = parseSalary(m[2] ?? '');
  if (!title || salary === null || salary === 'none') return null;
  return { title, salary };
}

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

/** Список регионов из текста «СПб, Татарстан, Москва»: узнанные субъекты и то, что распознать не вышло. */
export function parseRegionList(catalog: PackCatalog, text: string, limit: number): { regions: RegionInfo[]; unknown: string[] } {
  const regions: RegionInfo[] = [];
  const unknown: string[] = [];
  for (const part of text.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const r = findRegion(catalog, part);
    if (!r) { unknown.push(part); continue; }
    if (!regions.some((x) => x.fnsCode === r.fnsCode)) regions.push(r);
  }
  return { regions: regions.slice(0, limit), unknown };
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

  type ReplyExtra = Parameters<Context['reply']>[1];

  /** Длинный текст: режем по 4000 символов и держим паузу – лимит MAX 2 сообщения в секунду на чат. */
  const replyLong = async (ctx: Context, text: string, extra?: ReplyExtra): Promise<void> => {
    const parts = splitText(text);
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      await ctx.reply(part, last ? extra : undefined);
      if (!last) await sleep(MESSAGE_PAUSE_MS);
    }
  };

  /** Приветствие и следом путеводитель «Что умеет бот»: два сообщения с паузой под лимит MAX. */
  async function sendWelcome(ctx: Context, name: string | null) {
    await ctx.reply(T.welcomeText(name), { attachments: [T.welcomeKeyboard(deps.botUsername)] });
    await sleep(MESSAGE_PAUSE_MS);
    await ctx.reply(T.guideText(), { attachments: [T.guideKeyboard()] });
  }
  const sendGuide = (ctx: Context) => ctx.reply(T.guideText(), { attachments: [T.guideKeyboard()] });
  const sendHelp = (ctx: Context) => replyLong(ctx, T.helpText(), { attachments: [T.guideKeyboard()] });

  /** Запоминаем тексты своих должностей: по ключу «custom:<slug>» название не восстановить. */
  const rememberProfessionTexts = (uid: number, items: { key: string; text: string }[]) => {
    const texts = { ...state(uid).professionTexts };
    for (const it of items) if (isCustomProfessionKey(it.key)) { delete texts[it.key]; texts[it.key] = it.text; }
    setState(uid, { professionTexts: Object.fromEntries(Object.entries(texts).slice(-20)) });
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
      await ctx.reply(T.askInnText(), { attachments: [T.askInnKeyboard()] });
    }
  }

  /** Шаг ИНН пропущен: спрашиваем регион – без него рынок не с чем сравнивать. */
  async function skipInn(ctx: Context, uid: number) {
    setState(uid, { step: 'region' });
    await ctx.reply(T.askRegionText('skip'), { attachments: [T.askRegionKeyboard()] });
  }

  /** Регион нужен до штата или сводки: спрашиваем его и запоминаем, что продолжить. */
  async function askRegionFor(ctx: Context, uid: number, pending: 'staff' | 'digest') {
    setState(uid, { step: 'region', pending });
    await ctx.reply(T.askRegionText('first'), { attachments: [T.askRegionKeyboard()] });
  }

  async function handleInn(ctx: Context, uid: number, inn: string) {
    if (!isValidInn(inn)) {
      await ctx.reply('Похоже, это не ИНН: нужно 10 или 12 цифр.\n\nЧто дальше: напишите ИНН ещё раз или нажмите «Без ИНН, укажу регион».', { attachments: [T.askInnKeyboard()] });
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
      await ctx.reply(T.profileText(profile, pack, region.name, inspectionsProfileLine(checksFor(uid))), { attachments: [T.profileKeyboard()] });
    } catch (err) {
      log.warn({ err: String(err) }, 'profile lookup failed');
      await ctx.reply(`${err instanceof MarketError ? err.message : 'Не получилось найти бизнес в реестре МСП.'}\n\nЧто дальше: попробуйте ещё раз или нажмите «Без ИНН, укажу регион».`, { attachments: [T.askInnKeyboard()] });
    }
  }

  /** Профессия по ключу: пакет → общий каталог → сохранённый текст своей должности. */
  const professionByKey = (uid: number, key: string): Profession | null => {
    const pack = packFor(uid);
    const known = pack.professions.find((p) => p.key === key) ?? catalog.professions.find((p) => p.key === key);
    if (known) return known;
    if (!isCustomProfessionKey(key)) return null;
    const text = state(uid).professionTexts?.[key];
    return text ? resolveProfession(catalog, pack, text) : null;
  };

  async function runMarket(ctx: Context, uid: number, offer: number | null, override?: { inn: string | null; regionFnsCode: string | null; professionKey: string }) {
    const st = state(uid);
    const u = getUser(db, uid)!;
    const professionKey = override?.professionKey ?? st.professionKey;
    if (!professionKey) { await startFlow(ctx, uid); return; }
    if (!override && !u.regionFnsCode && !u.inn) { setState(uid, { step: 'region' }); await ctx.reply(T.askRegionText('first'), { attachments: [T.askRegionKeyboard()] }); return; }
    // Своя должность живёт только текстом в состоянии: без него ядро не знает, что запрашивать у источника.
    const profession = isCustomProfessionKey(professionKey) ? professionByKey(uid, professionKey) : null;
    if (isCustomProfessionKey(professionKey) && !profession) {
      setState(uid, { step: 'profession' });
      await ctx.reply('Потерял название вашей должности.\n\nЧто дальше: напишите её ещё раз или выберите из списка.', { attachments: [T.professionKeyboard(packFor(uid))] });
      return;
    }
    await ctx.api.sendAction(ctx.chatId!, 'typing_on').catch(() => undefined);
    const waiting = await ctx.reply('Считаю: запрашиваю объявления на «Работе России» и сверяю работодателей с реестром МСП. Обычно это 10–40 секунд, карточка появится в этом сообщении.');
    try {
      const result = await buildMarket(deps.market, { professionKey, profession, regionFnsCode: override ? override.regionFnsCode : (u.regionFnsCode ?? null), inn: override ? override.inn : (u.inn ?? null), offer, maxUserId: uid });
      setState(uid, { step: 'idle', lastCardId: result.cardId });
      const text = T.cardText(result);
      const extra = { attachments: [T.cardKeyboard(result, deps.botUsername)] };
      // Карточка длиннее лимита MAX не редактируется в одно сообщение: отправляем частями.
      if (text.length > MAX_MESSAGE_LENGTH) { await replyLong(ctx, text, extra); return; }
      await ctx.api.editMessage(waiting.body.mid, { text, ...extra }).catch(async () => {
        await ctx.reply(text, extra);
      });
    } catch (err) {
      const msg = err instanceof MarketError ? err.message : 'Не получилось посчитать рынок: что-то пошло не так.';
      log.error({ err: String(err) }, 'market failed');
      setState(uid, { step: 'idle' });
      await ctx.reply(`${msg}\n\nЧто дальше: нажмите «Повторить» или начните заново командой /stavka.`, { attachments: [Keyboard.inlineKeyboard([[Keyboard.button.callback('Повторить', `retry:${offer ?? 'none'}`)]])] });
    }
  }

  /* ---------- свободный ввод должности ---------- */

  /**
   * Должность текстом: сначала каталог пакета, затем подсказки из справочника ОКПДТР,
   * и в конце – расчёт по названию пользователя (профессия «custom:<slug>»).
   * Возвращает false, если из текста не вышло ни одной должности.
   * onlyKnown – для случайной реплики вне шага «должность»: без совпадений в справочниках
   * не предлагаем считать рынок по чему попало.
   */
  async function handleProfessionText(ctx: Context, uid: number, raw: string, opts: { onlyKnown?: boolean } = {}): Promise<boolean> {
    // Как в API: должность не длиннее 120 символов – иначе текст запроса к источнику и ответ бота вырастают до отказа MAX.
    const text = raw.slice(0, MAX_PROFESSION_TEXT).trim();
    if (!text) return false;
    const pack = packFor(uid);
    const known = findProfession(catalog, pack, text);
    if (known) {
      setState(uid, { step: 'salary', professionKey: known.key });
      await ctx.reply(T.askSalaryText(known.title), { attachments: [T.askSalaryKeyboard()] });
      return true;
    }
    const own = resolveProfession(catalog, pack, text);
    if (!own) return false;
    if (!isCustomProfessionKey(own.key)) {
      setState(uid, { step: 'salary', professionKey: own.key });
      await ctx.reply(T.askSalaryText(own.title), { attachments: [T.askSalaryKeyboard()] });
      return true;
    }
    const suggestions = suggestProfessions(catalog, text, 3);
    if (opts.onlyKnown && suggestions.length === 0) return false;
    rememberProfessionTexts(uid, [{ key: own.key, text: own.query }, ...suggestions.map((x) => ({ key: x.key, text: x.title }))]);
    setState(uid, { step: 'profession' });
    await ctx.reply(T.professionSuggestText(own.title, suggestions), { attachments: [T.professionSuggestKeyboard(own, suggestions)] });
    return true;
  }

  /* ---------- штат ---------- */

  async function startStaff(ctx: Context, uid: number) {
    const u = getUser(db, uid);
    if (!u?.regionFnsCode && !u?.inn) { await askRegionFor(ctx, uid, 'staff'); return; }
    setState(uid, { step: 'staff', staffRows: [] });
    await ctx.reply(T.staffIntroText(regionByFnsCode(catalog, u?.regionFnsCode ?? null)?.name ?? null), { attachments: [T.staffInputKeyboard()] });
  }

  /** Оценка собранного штата: рынки по каждой должности, текст сводки и кнопка в мини-приложение. */
  async function runStaff(ctx: Context, uid: number) {
    const rows = state(uid).staffRows ?? [];
    if (!rows.length) { await ctx.reply('Список пока пуст.\n\nЧто дальше: пришлите хотя бы одну строку вида «повар 60000», затем нажмите «Посчитать».', { attachments: [T.staffInputKeyboard()] }); return; }
    const u = getUser(db, uid)!;
    await ctx.api.sendAction(ctx.chatId!, 'typing_on').catch(() => undefined);
    await ctx.reply(`Считаю рынок по ${rows.length} ${pluralRu(rows.length, 'должности', 'должностям', 'должностям')}: запрашиваю объявления и сверяю работодателей с реестром МСП. Это может занять пару минут, результат придёт сюда.`);
    try {
      const result = await buildStaffAssessment(deps.market, {
        positions: rows.map((r, i) => ({ id: `p${i + 1}`, title: r.title, salary: r.salary })),
        inn: u.inn ?? null,
        regionFnsCode: u.regionFnsCode ?? null,
        maxUserId: uid,
      });
      setState(uid, { step: 'idle', staffRows: undefined });
      await replyLong(ctx, result.text, { attachments: [T.staffKeyboard(deps.botUsername)] });
    } catch (err) {
      const msg = err instanceof MarketError ? err.message : 'Не получилось посчитать штат: что-то пошло не так.';
      log.error({ err: String(err) }, 'staff failed');
      setState(uid, { step: 'staff' });
      await ctx.reply(`${msg}\n\nЧто дальше: список сохранён, нажмите «Посчитать», чтобы повторить.`, { attachments: [T.staffInputKeyboard()] });
    }
  }

  /* ---------- сравнение регионов ---------- */

  async function startRegions(ctx: Context, uid: number) {
    const st = state(uid);
    const card = st.lastCardId ? getCard<MarketResult>(db, st.lastCardId) : null;
    const prof = card?.payload.profession;
    if (prof) {
      rememberProfessionTexts(uid, [{ key: prof.key, text: prof.query }]);
      setState(uid, { step: 'regions', regionsProfessionKey: prof.key });
      await ctx.reply(T.askRegionsText(prof.title, BOT_MAX_REGIONS));
      return;
    }
    setState(uid, { step: 'regions_prof' });
    await ctx.reply(T.askRegionsProfessionText);
  }

  async function runRegions(ctx: Context, uid: number, profession: Profession, regions: RegionInfo[], unknown: string[]) {
    await ctx.api.sendAction(ctx.chatId!, 'typing_on').catch(() => undefined);
    await ctx.reply(`Сравниваю «${profession.title}»: ${regions.map((r) => r.name).join(', ')}. Это может занять пару минут, результат придёт сюда.`);
    try {
      const st = state(uid);
      const card = st.lastCardId ? getCard<MarketResult>(db, st.lastCardId) : null;
      const offer = card?.payload.profession.key === profession.key ? card.payload.card.offer?.value ?? null : null;
      const result = await compareRegions(deps.market, {
        profession,
        regionFnsCodes: regions.map((r) => r.fnsCode),
        offer,
        maxUserId: uid,
        inn: null,
        persist: false,
      });
      setState(uid, { step: 'idle' });
      const tail = unknown.length ? `\n\nНе узнал регионы: ${unknown.join(', ')}. Напишите их полным названием, например «Ленинградская область», и повторите: /regions.` : '';
      await replyLong(ctx, result.text + tail, { attachments: [T.regionsKeyboard(deps.botUsername)] });
    } catch (err) {
      const msg = err instanceof MarketError ? err.message : 'Не получилось сравнить регионы: что-то пошло не так.';
      log.error({ err: String(err) }, 'regions failed');
      setState(uid, { step: 'regions' });
      await ctx.reply(`${msg}\n\nЧто дальше: пришлите список регионов ещё раз или начните заново: /regions.`);
    }
  }

  /* ---------- сводка по региону (партнёрам) ---------- */

  async function runDigest(ctx: Context, uid: number) {
    const u = getUser(db, uid);
    const region = regionByFnsCode(catalog, u?.regionFnsCode ?? null);
    if (!region) { await askRegionFor(ctx, uid, 'digest'); return; }
    const pack = packFor(uid);
    const keys = pack.professions.slice(0, BOT_DIGEST_PROFESSIONS).map((p) => p.key);
    await ctx.api.sendAction(ctx.chatId!, 'typing_on').catch(() => undefined);
    await ctx.reply(`Собираю сводку по региону «${region.name}»: ${keys.length} ${pluralRu(keys.length, 'должность', 'должности', 'должностей')} отрасли «${pack.title}». Это может занять пару минут, результат придёт сюда.`);
    try {
      const result = await regionDigest(deps.market, region.fnsCode, keys, { persist: false });
      setState(uid, { step: 'idle' });
      await replyLong(ctx, result.text, { attachments: [T.digestKeyboard(deps.botUsername)] });
    } catch (err) {
      const msg = err instanceof MarketError ? err.message : 'Не получилось собрать сводку: что-то пошло не так.';
      log.error({ err: String(err) }, 'digest failed');
      await ctx.reply(`${msg}\n\nЧто дальше: попробуйте ещё раз через минуту: /digest.`);
    }
  }

  /* ---------- плановые проверки (ЕРКНМ) ---------- */

  /** Профиль бизнеса пользователя из кэша реестра МСП: нужен для региона и ОКВЭД в контексте проверок. */
  const cachedProfile = (uid: number): { okved: string | null; fnsRegionCode: string | null } | null => {
    const inn = getUser(db, uid)?.inn;
    if (!inn) return null;
    const row = db.prepare('SELECT payload FROM business_profiles WHERE inn = ?').get(inn) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as { okved: string | null; fnsRegionCode: string | null }) : null;
  };

  /** Блок «Проверки {год}»: плановые КНМ по ИНН и контекст по региону и отрасли. */
  const checksFor = (uid: number) => {
    const u = getUser(db, uid);
    const profile = cachedProfile(uid);
    return inspectionsForBusiness(deps.market, {
      inn: u?.inn ?? null,
      regionFnsCode: u?.regionFnsCode ?? profile?.fnsRegionCode ?? null,
      okved: profile?.okved ?? null,
    });
  };

  async function runChecks(ctx: Context, uid: number) {
    await replyLong(ctx, inspectionsText(checksFor(uid)), { attachments: [T.checksKeyboard(deps.botUsername, Boolean(getUser(db, uid)?.inn))] });
  }

  /* ---------- отклики и найм ---------- */

  // Контекст найма структурно совпадает с контекстом отчёта: та же БД, конфиг и бот.
  const hiring: HiringContext = deps.report;
  const regionNameOf = (code: string) => catalog.regions.find((r) => r.code === code || r.fnsCode === code)?.name ?? code;

  /** /vacancies: список с нумерацией, кнопки «N. Должность» открывают отклики в приложении. */
  async function showVacancies(ctx: Context, uid: number) {
    const items = listVacanciesByUser(db, uid);
    await replyLong(ctx, T.vacanciesListText(items), { attachments: [T.vacanciesKeyboard(deps.botUsername, items)] });
  }

  /** /subs: подписки с нумерацией, кнопка «Отписаться: N» по каждой. */
  async function showSubs(ctx: Context, uid: number) {
    const subs = listUserSubscriptions(db, uid);
    const items = subs.map((s) => ({
      id: s.id,
      title: `${catalog.professions.find((p) => p.key === s.professionKey)?.title ?? state(uid).professionTexts?.[s.professionKey] ?? s.professionKey}, ${regionNameOf(s.regionCode)}`,
    }));
    await replyLong(ctx, T.subsText(items), { attachments: [T.subsKeyboard(items)] });
  }

  /** Публикация вакансии из карточки рынка: черновик текста + диплинк + QR. */
  async function publishVacancy(ctx: Context, uid: number, result: MarketResult) {
    const pack = catalog.packs.find((p) => p.id === result.pack.id) ?? catalog.packs.find((p) => !p.region)!;
    const salary = T.publishSalary(result);
    const text = buildVacancyDraft({ card: result.card, profession: result.profession, pack, salary: salary ?? 0, companyName: result.profile?.name ?? null, cityName: result.region.name });
    const { vacancy, link } = createVacancyFromCard(hiring, {
      card: {
        cardId: result.cardId,
        professionKey: result.profession.key,
        professionTitle: result.profession.title,
        regionCode: result.region.code,
        regionName: result.region.name,
        employerName: result.profile?.name ?? null,
      },
      maxUserId: uid,
      salary,
      text,
    });
    const body = T.publishedVacancyText(vacancy, result.region.name, link);
    const keyboard = T.publishedVacancyKeyboard(vacancy, deps.botUsername, link);
    let attachments: unknown[] = [keyboard];
    try {
      const qrPath = await renderVacancyQr(hiring, vacancy.id, link);
      const image = await hiring.bot.api.uploadImage({ source: qrPath });
      attachments = [image.toJson(), keyboard];
    } catch (err) {
      log.warn({ err: String(err), vacancyId: vacancy.id }, 'QR вакансии не загрузился – отправляем без картинки');
    }
    await ctx.reply(body, { attachments: attachments as never });
    return vacancy;
  }

  /** Карточка вакансии кандидату, пришедшему по диплинку `vac_<id>`. */
  async function showVacancyToCandidate(ctx: Context, uid: number, vacancyId: string) {
    const vacancy = getVacancy(db, vacancyId);
    if (!vacancy) { await ctx.reply('Эта вакансия не найдена: возможно, ссылка устарела.\n\nЧто дальше: посмотрите, сколько платят по вашей должности в регионе: /stavka'); return; }
    setState(uid, { step: 'idle', vacancyId: vacancy.id, answers: {} });
    await replyLong(ctx, T.candidateVacancyText(vacancy, regionNameOf(vacancy.regionCode)), { attachments: [T.candidateVacancyKeyboard(vacancy)] });
  }

  /** Сохранение отклика, ответ кандидату и уведомление работодателя. */
  async function finishResponse(ctx: Context, uid: number, vacancy: VacancyRow, answers: CandidateAnswers, phone: string | null, phoneVerified: boolean) {
    const u = getUser(db, uid);
    const score = scoreResponse(vacancy, answers, Boolean(phone));
    const response = putResponse(db, {
      id: randomUUID(),
      vacancyId: vacancy.id,
      candidateUserId: uid,
      candidateName: u?.name ?? ctx.user?.first_name ?? null,
      answers,
      phone,
      phoneVerified,
      score,
    });
    setState(uid, { step: 'idle', vacancyId: undefined, answers: undefined });
    await ctx.reply(T.responseSentText(Boolean(phone)), { attachments: [T.responseSentKeyboard()] });
    try {
      await sendToUser(hiring, vacancy.maxUserId, responseSummary({ ...response, answers }, vacancy), {
        attachments: [Keyboard.inlineKeyboard([[inboxButton(deps.botUsername, vacancy.id)]])],
      });
    } catch (err) {
      log.warn({ err: String(err), vacancyId: vacancy.id }, 'не удалось уведомить работодателя об отклике');
    }
  }

  /** Вакансия, по которой кандидат сейчас отвечает; null – шаг устарел. */
  function applyTarget(uid: number, vacancyId?: string): VacancyRow | null {
    const id = vacancyId ?? state(uid).vacancyId;
    if (!id) return null;
    const v = getVacancy(db, id);
    return v && v.status === 'open' ? v : null;
  }

  /**
   * Кнопки шагов отклика (опыт, график, «без номера») относятся к вакансии, по которой отклик начат сейчас:
   * старая кнопка в предыдущем сообщении не должна переключать отклик на другую вакансию или создавать второй отклик.
   */
  async function applyInProgress(ack: (n?: string) => Promise<unknown>, uid: number, vacancy: VacancyRow): Promise<boolean> {
    if (state(uid).vacancyId !== vacancy.id) { await ack('Начните отклик заново: нажмите «Откликнуться» под вакансией'); return false; }
    if (findResponseByCandidate(db, vacancy.id, uid)) { await ack('Вы уже откликнулись'); return false; }
    return true;
  }

  /**
   * Карточка рынка из callback-кнопки. Как в API (ownsCard): чужой карточкой управлять нельзя – она видна
   * другим в групповом чате и по ссылке /start card_<id>. У анонимных карточек (демо-режим браузера, прогрев кэша)
   * автора нет: читать и получать PDF можно, публиковать вакансию и подписываться – нет.
   */
  async function cardFor(ack: (n?: string) => Promise<unknown>, uid: number, cardId: string, access: 'read' | 'manage'): Promise<CardRow<MarketResult> | null> {
    const row = getCard<MarketResult>(db, cardId);
    if (!row) { await ack('Карточка не найдена'); return null; }
    if (row.maxUserId != null && row.maxUserId !== uid) { await ack('Карточка принадлежит другому пользователю'); return null; }
    if (row.maxUserId == null && access === 'manage') { await ack('Это карточка демо-режима: посчитайте рынок по своему бизнесу: /stavka'); return null; }
    return row;
  }

  async function sendCardById(ctx: Context, uid: number, cardId: string) {
    const row = getCard<MarketResult>(db, cardId);
    if (!row) { await ctx.reply('Такой карточки нет: возможно, ссылка устарела.\n\nЧто дальше: начните заново: /stavka'); return; }
    await ctx.reply(T.cardText(row.payload), { attachments: [T.cardKeyboard(row.payload, deps.botUsername)] });
    setState(uid, { lastCardId: cardId });
  }

  /** Веб-клиент MAX иногда шлёт `bot_started` дважды за одно открытие ссылки – повтор с тем же payload в течение 90 с игнорируем. */
  const recentStarts = new Map<string, number>();
  function isRepeatedStart(uid: number, payload: string | null | undefined): boolean {
    const key = `${uid}:${payload ?? ''}`;
    const now = Date.now();
    const last = recentStarts.get(key);
    for (const [k, t] of recentStarts) if (now - t > 90_000) recentStarts.delete(k);
    recentStarts.set(key, now);
    return last !== undefined && now - last < 90_000;
  }

  bot.on('bot_started', async (ctx) => {
    const u = ensureUser(ctx);
    if (!u) return;
    const payload = ctx.startPayload;
    if (isRepeatedStart(u.maxUserId, payload)) return;
    if (payload && payload.startsWith('card_')) { await sendCardById(ctx, u.maxUserId, payload.slice(5)); return; }
    if (payload && payload.startsWith('vac_')) { await showVacancyToCandidate(ctx, u.maxUserId, payload.slice(4)); return; }
    await sendWelcome(ctx, u.name);
  });

  bot.on('bot_added', async (ctx) => {
    await ctx.reply('Здравствуйте! Я «Кадровый радар»: подскажу, сколько платить сотрудникам.\n\nЧто дальше: напишите /stavka, чтобы узнать, сколько платят за нужную должность в вашем регионе, или /help, чтобы увидеть всё, что умею.').catch(() => undefined);
  });

  bot.on('message_callback', async (ctx) => {
    const u = ensureUser(ctx);
    if (!u) return;
    const uid = u.maxUserId;
    const payload = ctx.callback?.payload ?? '';
    const cbId = ctx.callback?.callback_id;
    const ack = (notification?: string) => (cbId ? ctx.api.answerOnCallback(cbId, notification ? ({ notification } as never) : {}).catch(() => undefined) : Promise.resolve());

    if (payload === 'guide') { await ack(); await sendGuide(ctx); return; }
    if (payload === 'help') { await ack(); await sendHelp(ctx); return; }
    if (payload === 'vacancies') { await ack(); await showVacancies(ctx, uid); return; }
    if (payload === 'subs') { await ack(); await showSubs(ctx, uid); return; }
    if (payload === 'staff') { await ack(); await startStaff(ctx, uid); return; }
    if (payload === 'regions') { await ack(); await startRegions(ctx, uid); return; }
    if (payload === 'digest') { await ack(); await runDigest(ctx, uid); return; }
    if (payload === 'checks') { await ack(); await runChecks(ctx, uid); return; }
    if (payload === 'salary:none') { await ack(); await runMarket(ctx, uid, null); return; }
    if (payload === 'staff:done') { await ack(); if (state(uid).step !== 'staff') { await startStaff(ctx, uid); return; } await runStaff(ctx, uid); return; }
    if (payload === 'staff:cancel') {
      await ack();
      setState(uid, { step: 'idle', staffRows: undefined });
      await ctx.reply('Отменил, список очищен.\n\nЧто дальше: вернуться к штату – /staff, проверить одну ставку – кнопка ниже.', { attachments: [T.guideKeyboard()] });
      return;
    }
    if (payload === 'inn:new') { await ack(); setState(uid, { step: 'inn' }); await ctx.reply(T.askInnText(), { attachments: [T.askInnKeyboard()] }); return; }
    if (payload === 'inn:skip') { await ack(); await skipInn(ctx, uid); return; }
    if (payload === 'stavka') { await ack(); await startFlow(ctx, uid); return; }
    if (payload === 'profile:ok') { await ack(); setState(uid, { step: 'profession' }); const pack = packFor(uid); await ctx.reply(T.askProfessionText(pack), { attachments: [T.professionKeyboard(pack)] }); return; }
    if (payload === 'demo') {
      await ack();
      const demos = catalog.packs.filter((p) => p.demo);
      if (demos.length <= 1) { await runDemo(ctx, uid, demos[0]?.id); return; }
      await ctx.reply(T.demoChoiceText(), { attachments: [Keyboard.inlineKeyboard(demos.map((p) => [Keyboard.button.callback(T.packShortTitle(p), `demo:${p.id}`)]))] });
      return;
    }
    if (payload.startsWith('demo:')) { await ack(); await runDemo(ctx, uid, payload.slice(5)); return; }
    if (payload === 'prof:again') { await ack(); setState(uid, { step: 'profession' }); const pack = packFor(uid); await ctx.reply(T.askProfessionText(pack), { attachments: [T.professionKeyboard(pack)] }); return; }
    if (payload.startsWith('prof:')) {
      await ack();
      const key = payload.slice(5);
      const prof = professionByKey(uid, key);
      if (!prof) { await ctx.reply('Не нашёл такую должность.\n\nЧто дальше: выберите из списка или напишите название текстом.', { attachments: [T.professionKeyboard(packFor(uid))] }); return; }
      rememberProfessionTexts(uid, [{ key: prof.key, text: prof.query }]);
      setState(uid, { step: 'salary', professionKey: prof.key });
      await ctx.reply(T.askSalaryText(prof.title), { attachments: [T.askSalaryKeyboard()] });
      return;
    }
    if (payload.startsWith('retry:')) {
      const v = payload.slice(6);
      const offer = v === 'none' ? null : Number(v);
      if (offer !== null && !(offer >= 1000 && offer <= 5_000_000)) { await ack('Ставка вне диапазона'); return; }
      await ack();
      await runMarket(ctx, uid, offer);
      return;
    }
    if (payload.startsWith('vote:')) {
      const [, kind, cardId] = payload.split(':');
      const row = cardId ? getCard<MarketResult>(db, cardId) : null;
      if (!row || !kind) { await ack('Карточка не найдена'); return; }
      const mid = ctx.messageId ?? `card:${cardId}`;
      const tally = castVote(db, mid, uid, kind);
      const opt = row.payload.card.options.find((o) => o.kind === kind);
      await ack(opt ? `Учёл ваш голос: ${formatRub(opt.value)}` : 'Голос учтён');
      await ctx.reply(T.voteText(row.payload.profession.title, opt ?? null, row.payload.card.options, tally.counts, tally.total));
      return;
    }
    if (payload.startsWith('pdf:')) {
      const row = await cardFor(ack, uid, payload.slice(4), 'read');
      if (!row) return;
      await ack('Готовлю PDF…');
      await ctx.api.sendAction(ctx.chatId!, 'sending_file').catch(() => undefined);
      try {
        const r = await sendReportToChat(deps.report, row.payload, uid, ctx.chatId!);
        if (r.reused) await ctx.reply('Отчёт по этой карточке уже есть в чате выше, отправлен недавно.\n\nЧто дальше: переслать его партнёру можно из приложения, кнопка «Поделиться в MAX».');
      } catch (err) {
        log.error({ err: String(err) }, 'report failed');
        await ctx.reply('Не удалось отправить отчёт.\n\nЧто дальше: попробуйте ещё раз через минуту, кнопка «Прислать PDF-отчёт» под карточкой.');
      }
      return;
    }
    if (payload.startsWith('sub:')) {
      const row = await cardFor(ack, uid, payload.slice(4), 'manage');
      if (!row) return;
      const r = row.payload;
      upsertSubscription(db, { id: randomUUID(), maxUserId: uid, chatId: ctx.chatId!, packId: r.pack.id, professionKey: r.profession.key, regionCode: r.region.code, offer: r.card.offer?.value ?? null, lastMedian: r.card.stats?.median ?? null });
      await ack('Подписка оформлена');
      await ctx.reply(T.subscribedText(r.profession.title, r.region.name));
      return;
    }
    if (payload.startsWith('unsub:')) {
      const ok = deactivateSubscription(db, payload.slice(6), uid);
      await ack(ok ? 'Подписка отключена' : 'Подписка не найдена');
      return;
    }
    if (payload.startsWith('pub:')) {
      const cardId = payload.slice(4);
      const row = await cardFor(ack, uid, cardId, 'manage');
      if (!row) return;
      await ack('Публикую вакансию…');
      try {
        await publishVacancy(ctx, uid, row.payload);
      } catch (err) {
        log.error({ err: String(err), cardId }, 'publish vacancy failed');
        await ctx.reply('Не удалось опубликовать вакансию.\n\nЧто дальше: попробуйте ещё раз через минуту, кнопка «Опубликовать» под карточкой.');
      }
      return;
    }
    if (payload.startsWith('vacclose:')) {
      const vacancyId = payload.slice(9);
      const closed = closeVacancy(db, vacancyId, uid);
      if (!closed) { await ack('Вакансия не найдена или она не ваша'); return; }
      await ack('Вакансия закрыта');
      await ctx.reply(`Вакансия «${closed.title}» закрыта. Новые отклики по ссылке приниматься не будут, кандидатам без ответа я сообщил.\n\nЧто дальше: список вакансий и откликов – /vacancies, новая вакансия – /stavka.`);
      for (const r of listResponsesByVacancy(db, vacancyId)) {
        if (r.status === 'hired' || r.status === 'rejected') continue;
        await sendToUser(hiring, r.candidateUserId, `Вакансия «${closed.title}» закрыта. Спасибо за отклик!`).catch(() => undefined);
      }
      return;
    }
    if (payload.startsWith('apply:')) {
      const vacancy = applyTarget(uid, payload.slice(6));
      if (!vacancy) { await ack('Вакансия закрыта или не найдена'); return; }
      if (vacancy.maxUserId === uid) { await ack(); await ctx.reply('Это ваша вакансия: отклики придут сюда и в приложение, раздел «Вакансии и отклики».', { attachments: [Keyboard.inlineKeyboard([[inboxButton(deps.botUsername, vacancy.id)]])] }); return; }
      const existing = findResponseByCandidate(db, vacancy.id, uid);
      if (existing) {
        await ack('Вы уже откликнулись');
        const label = existing.status === 'invited' ? 'вас пригласили на собеседование' : existing.status === 'hired' ? 'вас приняли' : existing.status === 'rejected' ? 'работодатель отказал' : 'работодатель ещё смотрит отклики';
        await ctx.reply(`Ваш отклик на «${vacancy.title}» уже отправлен: ${label}.\n\nЧто дальше: ждите ответа здесь, в этом чате.`);
        return;
      }
      await ack();
      setState(uid, { step: 'apply_exp', vacancyId: vacancy.id, answers: {} });
      await ctx.reply(T.askExperienceText, { attachments: [T.experienceKeyboard(vacancy.id)] });
      return;
    }
    if (payload.startsWith('exp:')) {
      const [, key, vacancyId] = payload.split(':');
      const vacancy = applyTarget(uid, vacancyId);
      if (!vacancy || !key || !(key in EXPERIENCE_LABEL)) { await ack('Вакансия закрыта или не найдена'); return; }
      if (!(await applyInProgress(ack, uid, vacancy))) return;
      await ack(EXPERIENCE_LABEL[key as ExperienceKey]);
      setState(uid, { step: 'apply_schedule', vacancyId: vacancy.id, answers: { ...state(uid).answers, experience: key as ExperienceKey } });
      await ctx.reply(T.askScheduleText(vacancy), { attachments: [T.scheduleKeyboard(vacancy.id)] });
      return;
    }
    if (payload.startsWith('sch:')) {
      const [, value, vacancyId] = payload.split(':');
      const vacancy = applyTarget(uid, vacancyId);
      if (!vacancy) { await ack('Вакансия закрыта или не найдена'); return; }
      if (!(await applyInProgress(ack, uid, vacancy))) return;
      await ack(value === 'yes' ? 'Готов' : 'Не готов');
      setState(uid, { step: 'apply_salary', vacancyId: vacancy.id, answers: { ...state(uid).answers, schedule: value === 'yes' } });
      await ctx.reply(T.askSalaryExpectationText(vacancy), { attachments: [T.salaryExpectationKeyboard(vacancy.id)] });
      return;
    }
    if (payload.startsWith('expsal:')) {
      // Ожидания «как в вакансии» кнопкой: то же, что написать это словами.
      const [, , vacancyId] = payload.split(':');
      const vacancy = applyTarget(uid, vacancyId);
      if (!vacancy) { await ack('Вакансия закрыта или не найдена'); return; }
      if (!(await applyInProgress(ack, uid, vacancy))) return;
      const a = state(uid).answers ?? {};
      if (a.experience === undefined || a.schedule === undefined) { await ack('Начните отклик заново'); return; }
      await ack('Как в вакансии');
      setState(uid, { step: 'apply_phone', vacancyId: vacancy.id, answers: { ...a, expectedSalary: null } });
      await ctx.reply(T.askPhoneText, { attachments: [T.phoneKeyboard(vacancy.id)] });
      return;
    }
    if (payload.startsWith('nophone:')) {
      const vacancy = applyTarget(uid, payload.slice(8));
      if (!vacancy) { await ack('Вакансия закрыта или не найдена'); return; }
      if (!(await applyInProgress(ack, uid, vacancy))) return;
      const a = state(uid).answers ?? {};
      if (a.experience === undefined || a.schedule === undefined) { await ack('Начните отклик заново'); return; }
      await ack();
      await finishResponse(ctx, uid, vacancy, { experience: a.experience, schedule: a.schedule, expectedSalary: a.expectedSalary ?? null }, null, false);
      return;
    }
    if (payload.startsWith('text:')) {
      const row = await cardFor(ack, uid, payload.slice(5), 'read');
      if (!row) return;
      await ack();
      const r = row.payload;
      const pack = catalog.packs.find((p) => p.id === r.pack.id)!;
      const salary = r.card.options.find((o) => o.kind === 'median')?.value ?? r.card.offer?.value ?? r.card.stats?.median ?? 0;
      const text = buildVacancyDraft({ card: r.card, profession: r.profession, pack, salary, companyName: r.profile?.name ?? null, cityName: r.region.name });
      await replyLong(ctx, T.draftText(text), { attachments: [T.draftKeyboard(r, deps.botUsername)] });
      return;
    }
    await ack();
  });

  async function runDemo(ctx: Context, uid: number, packId?: string) {
    const pack = (packId ? catalog.packs.find((p) => p.id === packId && p.demo) : null) ?? catalog.packs.find((p) => p.demo) ?? null;
    if (!pack?.demo) { await ctx.reply('Готовый пример не настроен.\n\nЧто дальше: проверьте ставку по своему бизнесу: /stavka'); return; }
    await ctx.reply(T.demoIntroText(pack.demo.note ?? pack.demo.inn, pack.professions.find((p) => p.key === pack.demo!.profession)?.title ?? pack.demo.profession, pack.demo.salary));
    await runMarket(ctx, uid, pack.demo.salary, { inn: pack.demo.inn, regionFnsCode: pack.region?.fnsCode ?? null, professionKey: pack.demo.profession });
  }

  /** Вложение «контакт»: проверяем подпись MAX и завершаем отклик. */
  async function handleContact(ctx: Context, uid: number, payload: { vcf_info?: string | null; hash?: string | null }) {
    const st = state(uid);
    const vacancy = applyTarget(uid);
    const a = st.answers ?? {};
    if (!vacancy || a.experience === undefined || a.schedule === undefined) {
      await ctx.reply('Спасибо! Сейчас номер не нужен: отклик не начат или вакансия уже закрыта.\n\nЧто дальше: откройте вакансию по ссылке работодателя и нажмите «Откликнуться».');
      return;
    }
    // Пересланный из адресной книги чужой контакт приходит без vcf_info – это не номер кандидата.
    const vcf = payload.vcf_info ?? '';
    if (!vcf) {
      await ctx.reply('Это чужой контакт из адресной книги, а нужен ваш номер.\n\nЧто дальше: нажмите «Поделиться номером» или «Без номера».', { attachments: [T.phoneKeyboard(vacancy.id)] });
      return;
    }
    const verified = verifyContactSignature(deps.market.config.botToken ?? '', vcf, payload.hash);
    const phone = phoneFromVcf(vcf) ?? ctx.contactInfo?.tel ?? null;
    if (!verified) log.warn({ uid, vacancyId: vacancy.id }, 'подпись контакта не сошлась – сохраняем номер как непроверенный');
    await finishResponse(ctx, uid, vacancy, { experience: a.experience, schedule: a.schedule, expectedSalary: a.expectedSalary ?? null }, phone, verified);
  }

  bot.on('message_created', async (ctx) => {
    const u = ensureUser(ctx);
    if (!u) return;
    const uid = u.maxUserId;
    const contact = (ctx.message?.body?.attachments ?? []).find((x) => x.type === 'contact');
    if (contact) { await handleContact(ctx, uid, contact.payload); return; }
    const text = (ctx.message?.body?.text ?? '').trim();
    if (!text) return;
    const cmd = /^\/(\w+)/.exec(text)?.[1]?.toLowerCase();
    if (cmd === 'start') {
      const arg = text.slice(text.indexOf('start') + 5).trim();
      if (arg.startsWith('vac_')) { await showVacancyToCandidate(ctx, uid, arg.slice(4)); return; }
      if (arg.startsWith('card_')) { await sendCardById(ctx, uid, arg.slice(5)); return; }
      await sendWelcome(ctx, u.name);
      return;
    }
    if (cmd === 'vacancies') { await showVacancies(ctx, uid); return; }
    if (cmd === 'help') { await sendHelp(ctx); return; }
    if (cmd === 'demo') {
      const demos = catalog.packs.filter((p) => p.demo);
      if (demos.length <= 1) { await runDemo(ctx, uid, demos[0]?.id); return; }
      await ctx.reply(T.demoChoiceText(), { attachments: [Keyboard.inlineKeyboard(demos.map((p) => [Keyboard.button.callback(T.packShortTitle(p), `demo:${p.id}`)]))] });
      return;
    }
    if (cmd === 'profile') { setState(uid, { step: 'inn' }); await ctx.reply(T.askInnText(), { attachments: [T.askInnKeyboard()] }); return; }
    if (cmd === 'stavka') { await startFlow(ctx, uid); return; }
    if (cmd === 'staff') { await startStaff(ctx, uid); return; }
    if (cmd === 'regions') { await startRegions(ctx, uid); return; }
    if (cmd === 'digest') { await runDigest(ctx, uid); return; }
    if (cmd === 'checks') { await runChecks(ctx, uid); return; }
    if (cmd === 'subs') { await showSubs(ctx, uid); return; }

    const st = state(uid);
    switch (st.step) {
      case 'inn': {
        if (/^(пропустить|нет|skip)$/i.test(text)) { await skipInn(ctx, uid); return; }
        await handleInn(ctx, uid, text.replace(/\D/g, ''));
        return;
      }
      case 'region': {
        const region = findRegion(catalog, text);
        if (!region) { await ctx.reply('Не узнал регион.\n\nЧто дальше: напишите название региона полностью, например «Московская область» или «Республика Татарстан».', { attachments: [T.askRegionKeyboard()] }); return; }
        updateUser(db, uid, { regionFnsCode: region.fnsCode });
        const pending = st.pending;
        setState(uid, { step: 'profession', pending: undefined });
        if (pending === 'staff') { await startStaff(ctx, uid); return; }
        if (pending === 'digest') { await runDigest(ctx, uid); return; }
        const pack = packFor(uid);
        await ctx.reply(`Регион: ${region.name}. Шаг 1 из 3 пройден.\n\n${T.askProfessionText(pack)}`, { attachments: [T.professionKeyboard(pack)] });
        return;
      }
      case 'profession': {
        if (/^\d[\d\s]{3,8}$/.test(text)) { await ctx.reply('Это похоже на ставку, а сейчас шаг 2 из 3: должность.\n\nЧто дальше: напишите должность, например «повар», ставку спрошу следующим шагом.', { attachments: [T.professionKeyboard(packFor(uid))] }); return; }
        if (await handleProfessionText(ctx, uid, text)) return;
        await ctx.reply('Не понял должность.\n\nЧто дальше: выберите кнопкой или напишите название, например «повар», «продавец», «сварщик».', { attachments: [T.professionKeyboard(packFor(uid))] });
        return;
      }
      case 'staff': {
        const t = normalizeText(text).replace(/[.!…]+$/u, '');
        if (/^(отмена|стоп|хватит|отменить)$/.test(t)) { setState(uid, { step: 'idle', staffRows: undefined }); await ctx.reply('Отменил, список очищен.\n\nЧто дальше: вернуться к штату – /staff, проверить одну ставку – кнопка ниже.', { attachments: [T.guideKeyboard()] }); return; }
        if (/^(готово|готов|все|посчитать|оценить|конец)$/.test(t)) { await runStaff(ctx, uid); return; }
        const rows = [...(st.staffRows ?? [])];
        const skipped: string[] = [];
        let added = 0;
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          if (rows.length >= MAX_STAFF_POSITIONS) break;
          const parsed = parseStaffLine(line);
          if (!parsed) { skipped.push(line.trim().slice(0, 40)); continue; }
          rows.push({ ...parsed, title: parsed.title.slice(0, 120) });
          added += 1;
        }
        setState(uid, { step: 'staff', staffRows: rows });
        if (!added) { await ctx.reply('Не понял строку. Нужен формат «должность ставка», например «повар 60000».\n\nЧто дальше: пришлите строку ещё раз; когда закончите, нажмите «Посчитать».', { attachments: [T.staffInputKeyboard()] }); return; }
        const full = rows.length >= MAX_STAFF_POSITIONS;
        await ctx.reply(T.staffAddedText(added, rows.length, skipped) + (full ? `\nЭто максимум за раз (${MAX_STAFF_POSITIONS} строк), считаю.` : ''), full ? undefined : { attachments: [T.staffInputKeyboard()] });
        if (rows.length >= MAX_STAFF_POSITIONS) { await sleep(MESSAGE_PAUSE_MS); await runStaff(ctx, uid); }
        return;
      }
      case 'regions_prof': {
        const pack = packFor(uid);
        const query = text.slice(0, MAX_PROFESSION_TEXT).trim();
        const prof = findProfession(catalog, pack, query) ?? resolveProfession(catalog, pack, query);
        if (!prof) { await ctx.reply('Не понял должность.\n\nЧто дальше: напишите название, например «повар».'); return; }
        rememberProfessionTexts(uid, [{ key: prof.key, text: prof.query }]);
        setState(uid, { step: 'regions', regionsProfessionKey: prof.key });
        await ctx.reply(T.askRegionsText(prof.title, BOT_MAX_REGIONS));
        return;
      }
      case 'regions': {
        const profession = st.regionsProfessionKey ? professionByKey(uid, st.regionsProfessionKey) : null;
        if (!profession) { setState(uid, { step: 'regions_prof' }); await ctx.reply(T.askRegionsProfessionText); return; }
        const { regions, unknown } = parseRegionList(catalog, text, BOT_MAX_REGIONS);
        if (!regions.length) { await ctx.reply('Не узнал ни одного региона.\n\nЧто дальше: напишите их через запятую, например «СПб, Татарстан, Москва».'); return; }
        await runRegions(ctx, uid, profession, regions, unknown);
        return;
      }
      case 'salary': {
        const s = parseSalary(text);
        if (s === null) { await ctx.reply('Не понял сумму.\n\nЧто дальше: напишите число в рублях в месяц, например 45000, или нажмите «Пока без ставки».', { attachments: [T.askSalaryKeyboard()] }); return; }
        await runMarket(ctx, uid, s === 'none' ? null : s);
        return;
      }
      case 'apply_exp':
      case 'apply_schedule': {
        const vacancy = applyTarget(uid);
        if (!vacancy) { await ctx.reply('Вакансия уже закрыта или ссылка устарела.\n\nЧто дальше: посмотрите, сколько платят по вашей должности: /stavka'); setState(uid, { step: 'idle', vacancyId: undefined, answers: undefined }); return; }
        if (st.step === 'apply_exp') await ctx.reply(T.askExperienceText, { attachments: [T.experienceKeyboard(vacancy.id)] });
        else await ctx.reply(T.askScheduleText(vacancy), { attachments: [T.scheduleKeyboard(vacancy.id)] });
        return;
      }
      case 'apply_salary': {
        const vacancy = applyTarget(uid);
        if (!vacancy) { await ctx.reply('Вакансия уже закрыта или ссылка устарела.\n\nЧто дальше: посмотрите, сколько платят по вашей должности: /stavka'); setState(uid, { step: 'idle', vacancyId: undefined, answers: undefined }); return; }
        const asInVacancy = /^(как в вакансии|как в вакансии\.|как указано|любая|не важно|неважно)$/.test(normalizeText(text));
        const s = asInVacancy ? 'none' : parseSalary(text);
        if (s === null) { await ctx.reply('Не понял сумму.\n\nЧто дальше: напишите число в рублях в месяц, например 60000, или нажмите «Как в вакансии».', { attachments: [T.salaryExpectationKeyboard(vacancy.id)] }); return; }
        setState(uid, { step: 'apply_phone', answers: { ...st.answers, expectedSalary: s === 'none' ? null : s } });
        await ctx.reply(T.askPhoneText, { attachments: [T.phoneKeyboard(vacancy.id)] });
        return;
      }
      case 'apply_phone': {
        const vacancy = applyTarget(uid);
        if (!vacancy) { await ctx.reply('Вакансия уже закрыта или ссылка устарела.\n\nЧто дальше: посмотрите, сколько платят по вашей должности: /stavka'); setState(uid, { step: 'idle', vacancyId: undefined, answers: undefined }); return; }
        await ctx.reply('Остался последний шаг.\n\nЧто дальше: нажмите «Поделиться номером», чтобы работодатель мог позвонить, или «Без номера», тогда он ответит сообщением в MAX.', { attachments: [T.phoneKeyboard(vacancy.id)] });
        return;
      }
      default: {
        const inn = text.replace(/\D/g, '');
        if ((inn.length === 10 || inn.length === 12) && isValidInn(inn)) { await handleInn(ctx, uid, inn); return; }
        // Регион уже известен: свободный текст считаем должностью (каталог, подсказки ОКПДТР или своя).
        if (getUser(db, uid)?.regionFnsCode && await handleProfessionText(ctx, uid, text, { onlyKnown: true })) return;
        await ctx.reply(T.fallbackText(), { attachments: [T.welcomeKeyboard(deps.botUsername)] });
      }
    }
  });

  bot.catch((err, ctx) => {
    log.error({ err: String(err), update: ctx.update.update_type }, 'unhandled bot error');
  });

  void bot.api.setMyCommands(COMMANDS).catch((err) => log.warn({ err: String(err) }, 'setMyCommands failed'));
}
