/**
 * fetch для клиента MAX Bot API с таймаутом. SDK передаёт signal в запрос, только если его задал
 * вызывающий код; иначе единственный предел – 300 с у undici, и один зависший вызов
 * (отчёт в чат, уведомление кандидату) держит обработчик события пять минут.
 */

/** Предел одного вызова Bot API (сообщения, ответы на кнопки, GET /me, подписки). */
export const BOT_API_TIMEOUT_MS = 20_000;
/** Long polling держит соединение до 30 с (query timeout=30) – ему нужен запас. */
const POLLING_TIMEOUT_MS = 60_000;

export function createBotFetch(base: typeof fetch = fetch, timeoutMs = BOT_API_TIMEOUT_MS): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const ms = /\/updates(\?|$)/.test(url) ? Math.max(timeoutMs, POLLING_TIMEOUT_MS) : timeoutMs;
    const timeout = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, signal });
  };
}

export const botFetch = createBotFetch();
