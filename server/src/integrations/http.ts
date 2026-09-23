/** Общий HTTP-слой для внешних источников: таймаут, повторы с задержкой, разбор JSON. */

export class SourceError extends Error {
  constructor(public readonly source: string, message: string, public readonly status?: number, public readonly retryable = false) {
    super(`${source}: ${message}`);
    this.name = 'SourceError';
  }
}

export interface FetchJsonOptions {
  source: string;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchJson<T>(url: string, opts: FetchJsonOptions): Promise<T> {
  const { source, timeoutMs = 25_000, retries = 2 } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: { accept: 'application/json', 'user-agent': 'stavka-max/0.1 (+hackathon MAX)', ...opts.headers },
        body: opts.body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const retryable = RETRYABLE.has(res.status);
        lastError = new SourceError(source, `HTTP ${res.status}`, res.status, retryable);
        if (!retryable) throw lastError;
      } else {
        const text = await res.text();
        return parseJsonLenient<T>(text, source);
      }
    } catch (err) {
      lastError = err instanceof SourceError ? err : new SourceError(source, (err as Error).name === 'AbortError' ? `таймаут ${timeoutMs} мс` : String((err as Error).message ?? err), undefined, true);
      if (!(lastError as SourceError).retryable) throw lastError;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw lastError;
}

/**
 * «Работа России» иногда отдаёт JSON с недопустимыми escape-последовательностями
 * (например, `5\\2` внутри строки). Сначала пробуем строгий разбор, затем чиним экранирование.
 */
export function parseJsonLenient<T>(text: string, source: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const fixed = text.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
    try {
      return JSON.parse(fixed) as T;
    } catch (err) {
      throw new SourceError(source, `невалидный JSON: ${(err as Error).message}`);
    }
  }
}
