/**
 * Ограничение параллелизма для обращений к внешним источникам.
 * «Работа России» отдаёт страницу за 6–11 с и не любит шквал запросов,
 * поэтому массовые сценарии (сравнение регионов, штат, сводка) идут пачками.
 */

/** Ошибка одного элемента не роняет остальные: результат приходит как { value } или { error }. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };

/** Выполняет fn для каждого элемента, держа не более `limit` задач одновременно; порядок результатов сохраняется. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<Settled<R>[]> {
  const out: Settled<R>[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (let i = cursor; i < items.length; i = cursor) {
      cursor += 1;
      try {
        out[i] = { ok: true, value: await fn(items[i]!, i) };
      } catch (err) {
        out[i] = { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
