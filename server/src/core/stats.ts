import type { HistogramBucket, SalaryStats } from './types.js';

/** Квантиль по отсортированному массиву (линейная интерполяция, тип 7, как в R/NumPy). */
export function quantileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0]!;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (h - lo);
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return quantileSorted(s, 0.5);
}

export function salaryStats(values: number[]): SalaryStats | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((acc, x) => acc + x, 0);
  return {
    n: s.length,
    median: Math.round(quantileSorted(s, 0.5)),
    p25: Math.round(quantileSorted(s, 0.25)),
    p75: Math.round(quantileSorted(s, 0.75)),
    min: s[0]!,
    max: s[s.length - 1]!,
    mean: Math.round(sum / s.length),
  };
}

/** Перцентиль значения: доля выборки ниже него плюс половина равных (полуранг), 0–100. */
export function percentileOf(values: number[], x: number): number {
  if (values.length === 0) return NaN;
  let below = 0; let equal = 0;
  for (const v of values) { if (v < x) below += 1; else if (v === x) equal += 1; }
  return Math.round((100 * (below + equal / 2)) / values.length);
}

/** Гистограмма с «круглыми» границами; ширина корзины подбирается под 6–8 корзин. */
export function histogram(values: number[], buckets = 8): HistogramBucket[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ from: min, to: max, count: values.length }];
  const rawWidth = (max - min) / buckets;
  const magnitude = 10 ** Math.floor(Math.log10(rawWidth));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((w) => w >= rawWidth) ?? rawWidth;
  const start = Math.floor(min / nice) * nice;
  const result: HistogramBucket[] = [];
  for (let from = start; from <= max; from += nice) {
    const to = from + nice;
    const count = values.filter((v) => v >= from && (v < to || (to > max && v <= max))).length;
    result.push({ from, to, count });
  }
  return result;
}
