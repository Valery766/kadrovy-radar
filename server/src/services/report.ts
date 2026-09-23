/**
 * Отчёт в чат: PDF рендерится детерминированно, загружается в MAX (POST /uploads),
 * отправляется ботом в диалог пользователя. Полученный mid сохраняется — по нему
 * мини-приложение пересылает отчёт в любой чат через window.WebApp.shareMaxContent({mid}).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bot } from '@maxhub/max-bot-api';
import { Keyboard } from '@maxhub/max-bot-api';
import type { Db } from '../db/index.js';
import { getReportByCard, putReport } from '../db/index.js';
import { renderMarketPdf } from '../report/pdf.js';
import type { MarketResult } from './market.js';
import type { Config } from '../config.js';
import { formatRub } from '../core/index.js';

export interface ReportContext { db: Db; config: Config; bot: Bot; botUsername: string }

export function cardDeepLink(botUsername: string, cardId: string): string {
  return `https://max.ru/${botUsername}?startapp=card_${cardId}`;
}

/** Кнопка открытия мини-приложения: web_app — ник бота, к которому привязано приложение; payload → initData.start_param. */
export function openRadarButton(botUsername: string, cardId: string | null, text = 'Подробный разбор') {
  return Keyboard.button.openApp(text, botUsername, undefined, cardId ? `card_${cardId}` : undefined);
}

export async function sendReportToChat(ctx: ReportContext, result: MarketResult, userId: number, chatId: number): Promise<{ mid: string; reportId: string; reused: boolean }> {
  const existing = getReportByCard(ctx.db, result.cardId, userId);
  if (existing?.mid && existing.chatId === chatId && Date.now() - Date.parse(existing.createdAt) < 6 * 3600_000) {
    return { mid: existing.mid, reportId: existing.id, reused: true };
  }
  const pdf = await renderMarketPdf(result, { appUrl: cardDeepLink(ctx.botUsername, result.cardId) });
  const dir = join(ctx.config.dataDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const reportId = randomUUID();
  const safeProf = result.profession.key;
  const filePath = join(dir, `stavka-${safeProf}-${reportId.slice(0, 8)}.pdf`);
  writeFileSync(filePath, pdf);
  const file = await ctx.bot.api.uploadFile({ source: filePath });
  const { card, profession, region } = result;
  const text = [
    `📄 Отчёт «Кадрового радара»: ${profession.title}, ${region.name}.`,
    card.stats ? `Медиана ${formatRub(card.stats.median)}, половина предложений ${formatRub(card.stats.p25)}–${formatRub(card.stats.p75)}; выборка ${card.sample.vacancies} вак. / ${card.sample.employers} работод.` : 'Данных для расчёта не хватило.',
    'Переслать отчёт партнёру или бухгалтеру можно из приложения — кнопка «Поделиться отчётом».',
  ].join('\n');
  const keyboard = Keyboard.inlineKeyboard([[openRadarButton(ctx.botUsername, result.cardId)]]);
  const message = await ctx.bot.api.sendMessageToChat(chatId, text, { attachments: [file.toJson(), keyboard] });
  const mid = message.body.mid;
  putReport(ctx.db, { id: reportId, cardId: result.cardId, maxUserId: userId, chatId, mid, filePath });
  return { mid, reportId, reused: false };
}
