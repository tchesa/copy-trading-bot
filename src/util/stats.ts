export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function median(xs: number[]): number {
  return quantile([...xs].sort((a, b) => a - b), 0.5);
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export interface Stats {
  n: number;
  mean: number;
  median: number;
  hit: number;
  p1: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
  p99: number;
}

export function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    mean: mean(s),
    median: quantile(s, 0.5),
    hit: s.length ? s.filter((x) => x > 0).length / s.length : NaN,
    p1: quantile(s, 0.01),
    p5: quantile(s, 0.05),
    p25: quantile(s, 0.25),
    p75: quantile(s, 0.75),
    p95: quantile(s, 0.95),
    p99: quantile(s, 0.99),
  };
}

/** Drop the top `frac` of values (e.g. 0.01 = top 1%). */
export function trimTop(xs: number[], frac: number): number[] {
  const s = [...xs].sort((a, b) => a - b);
  return s.slice(0, s.length - Math.ceil(s.length * frac));
}

/** Average ranks (1-based), ties share the mean rank. */
export function ranks(xs: number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = avg;
    i = j + 1;
  }
  return r;
}

export function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return NaN;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

export function spearman(a: number[], b: number[]): number {
  return pearson(ranks(a), ranks(b));
}
