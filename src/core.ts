// Pure helpers shared by the background worker, the content script and the tests.
import type { TrendResult, YearFit } from './types.ts';

/** Semantic Scholar refuses offset + limit >= 10000 on the citations list. */
export const LIST_CAP = 9999;

const UP_RATIO = 1.2;
const DOWN_RATIO = 0.8;
/** Citations per year; keeps tiny counts from flapping between labels. */
const MIN_ABS_CHANGE = 3;
/** Without a fit, use this year's annualised pace only once half the year has passed. */
const PACE_MIN_YEAR_FRACTION = 0.5;

/** Fewer dated citations or months than this and the curve is noise. */
const FIT_MIN_MONTHS = 6;
const FIT_MIN_CITATIONS = 20;
/** Months of history the curve is fitted on. */
const FIT_MAX_MONTHS = 84;

/** "/abs/2010.08895v3" -> "2010.08895"; old-style ids like "/abs/hep-th/9901001v2" too. */
export function arxivIdFromPath(pathname: string): string | null {
  const m = /^\/abs\/(.+?)\/?$/.exec(pathname);
  if (!m || !m[1]) return null;
  const id = decodeURIComponent(m[1]).replace(/v\d+$/, '');
  if (/^\d{4}\.\d{4,5}$/.test(id)) return id;
  if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}$/.test(id)) return id;
  return null;
}

/** Submission year encoded in the id: "2305.13301" -> 2023, "hep-th/9901001" -> 1999. */
export function arxivYear(id: string): number | null {
  const m = /^(\d{2})\d{2}\./.exec(id) ?? /\/(\d{2})\d{5}$/.exec(id);
  if (!m || !m[1]) return null;
  const yy = Number(m[1]);
  return yy >= 91 ? 1900 + yy : 2000 + yy;
}

export interface CitingRow {
  year?: number | null;
  publicationDate?: string | null;
}

/**
 * Buckets citing papers by year and by month. Rows with no year, a year before
 * `firstYear` (index errors: a paper cannot be cited before it exists) or after
 * `currentYear` are counted as excluded.
 */
export function bucketCitations(
  rows: Iterable<CitingRow>,
  firstYear: number,
  currentYear: number,
): { counts: Record<number, number>; months: Record<string, number>; excluded: number } {
  const counts: Record<number, number> = {};
  const months: Record<string, number> = {};
  let excluded = 0;
  for (const r of rows) {
    const y = r.year;
    if (typeof y !== 'number' || !Number.isInteger(y) || y < firstYear || y > currentYear) {
      excluded++;
      continue;
    }
    counts[y] = (counts[y] ?? 0) + 1;
    const d = r.publicationDate;
    if (d && d.length >= 7 && Number(d.slice(0, 4)) === y) {
      const k = d.slice(0, 7);
      months[k] = (months[k] ?? 0) + 1;
    }
  }
  return { counts, months, excluded };
}

export function monthKey(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, '0')}`;
}

export function yearFraction(now: Date): number {
  const y = now.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return (now.getTime() - start) / (end - start);
}

/** Logistic function. */
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface SCurve {
  /** Baseline rate. */
  b: number;
  /** Rate change across the S (negative for a falling S). */
  K: number;
  /** Steepness per month. */
  k: number;
  /** Midpoint, in months from the first fitted month. */
  t0: number;
}

export const scurveAt = (c: SCurve, t: number) => Math.max(0, c.b + c.K * sigmoid(c.k * (t - c.t0)));

/**
 * Fits rate(t) = b + K * sigmoid(k (t - t0)) by weighted least squares. For fixed
 * (k, t0) the model is linear in (b, K), so those are solved exactly while k and t0
 * are searched on a grid, then refined on a finer one. The rate is kept at or
 * above zero across the fitted range.
 */
export function fitSCurve(y: readonly number[], w: readonly number[]): SCurve | null {
  const n = y.length;
  if (n < 3) return null;
  let best: (SCurve & { sse: number }) | null = null;

  const tryFit = (k: number, t0: number) => {
    let sw = 0, sg = 0, sgg = 0, sy = 0, sgy = 0;
    const g: number[] = [];
    for (let i = 0; i < n; i++) {
      const gi = sigmoid(k * (i - t0));
      g.push(gi);
      const wi = w[i]!;
      sw += wi; sg += wi * gi; sgg += wi * gi * gi; sy += wi * y[i]!; sgy += wi * gi * y[i]!;
    }
    const det = sw * sgg - sg * sg;
    let b: number, K: number;
    if (Math.abs(det) > 1e-12 * sw * sgg) {
      b = (sgg * sy - sg * sgy) / det;
      K = (sw * sgy - sg * sy) / det;
    } else {
      b = sy / sw;
      K = 0;
    }
    // Keep the rate non-negative at both ends of the S.
    const gmin = Math.min(...g), gmax = Math.max(...g);
    if (b + K * gmin < 0 || b + K * gmax < 0) {
      // Pin the low end at zero: rate = K * (g - gLow) where gLow is the low end.
      const gl = K >= 0 ? gmin : gmax;
      let num = 0, den = 0;
      for (let i = 0; i < n; i++) {
        const d = g[i]! - gl;
        num += w[i]! * d * y[i]!;
        den += w[i]! * d * d;
      }
      K = den > 0 ? num / den : 0;
      b = -K * gl;
    }
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const r = y[i]! - (b + K * g[i]!);
      sse += w[i]! * r * r;
    }
    if (!best || sse < best.sse) best = { b, K, k, t0, sse };
  };

  const ks = [0.02, 0.035, 0.05, 0.07, 0.1, 0.14, 0.2, 0.28, 0.4];
  for (const k of ks) for (let t0 = -24; t0 <= n + 24; t0 += 1) tryFit(k, t0);
  const coarse = best as (SCurve & { sse: number }) | null;
  if (!coarse) return null;
  for (let f = 0.7; f <= 1.45; f += 0.05) {
    for (let d = -1.5; d <= 1.5; d += 0.25) tryFit(coarse.k * f, coarse.t0 + d);
  }
  const { b, K, k, t0 } = best as unknown as SCurve;
  // A falling S is the same curve with k < 0; normalise so k is always positive.
  return { b, K, k, t0 };
}

/**
 * Fits an S-curve to the monthly citation rate and extrapolates it to December.
 * Months use dated citations only, scaled per year so each year's months add up to
 * that year's full count. The current, partial month is left out of the fit.
 * An S-curve rises (or falls) and then levels off, so the extrapolation cannot run away.
 */
export function fitYear(
  data: { counts: Record<number, number>; months: Record<string, number>; capped: readonly number[]; firstYear: number },
  now: Date,
): YearFit | null {
  const Y = now.getUTCFullYear();
  const M = now.getUTCMonth();
  if (data.capped.includes(Y) || data.capped.includes(Y - 1)) return null;

  const monthsSum = (y: number) => {
    let s = 0;
    for (let m = 0; m < 12; m++) s += data.months[monthKey(y, m)] ?? 0;
    return s;
  };
  const scaleCache = new Map<number, number>();
  const scale = (y: number) => {
    let s = scaleCache.get(y);
    if (s === undefined) {
      const dated = monthsSum(y);
      s = dated > 0 ? Math.min(2, Math.max(1, (data.counts[y] ?? 0) / dated)) : 1;
      scaleCache.set(y, s);
    }
    return s;
  };

  // Last complete month, then walk back to the first month with data.
  let endY = Y, endM = M - 1;
  if (endM < 0) { endY--; endM = 11; }
  const endIdx = endY * 12 + endM;
  let startIdx = Math.max(data.firstYear * 12, endIdx - FIT_MAX_MONTHS + 1);
  while (startIdx <= endIdx) {
    const y = Math.floor(startIdx / 12);
    if ((data.months[monthKey(y, startIdx % 12)] ?? 0) > 0) break;
    startIdx++;
  }
  const n = endIdx - startIdx + 1;
  if (n < FIT_MIN_MONTHS) return null;

  const series: number[] = [];
  let raw = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    const y = Math.floor(i / 12);
    const v = data.months[monthKey(y, i % 12)] ?? 0;
    raw += v;
    series.push(v * scale(y));
  }
  if (raw < FIT_MIN_CITATIONS) return null;

  // Poisson-like weights from a 3-month average, plus a mild preference for
  // recent months (2-year half-life) since the projection is about now.
  const weights = series.map((_, i) => {
    const lo = Math.max(0, i - 1), hi = Math.min(n - 1, i + 1);
    let m = 0;
    for (let j = lo; j <= hi; j++) m += series[j]!;
    m /= hi - lo + 1;
    return 0.5 ** ((n - 1 - i) / 24) / Math.max(2, m);
  });
  const curve = fitSCurve(series, weights);
  if (!curve) return null;
  const smooth = series.map((_, i) => scurveAt(curve, i));

  const remaining = endY < Y ? 12 : 11 - endM;
  const future: number[] = [];
  for (let k = 1; k <= remaining; k++) future.push(scurveAt(curve, n - 1 + k));

  let soFar = 0;
  if (endY === Y) for (let m = 0; m <= endM; m++) soFar += data.months[monthKey(Y, m)] ?? 0;
  const projected = Math.max(data.counts[Y] ?? 0, soFar * scale(Y) + future.reduce((a, b) => a + b, 0));

  return { startYear: Math.floor(startIdx / 12), startMonth: startIdx % 12, smooth, future, projected };
}

/**
 * Labels the citation trend. With a fit it compares the projected total for this
 * year with last year. Without one it uses this year's annualised pace from July,
 * or the last two full years before that. "Up" and "down" need a 20% change and
 * at least 3 citations a year of difference.
 */
export function classifyTrend(
  counts: Record<number, number>,
  opts: { now?: Date; pubYear: number | null; capped?: readonly number[]; projected?: number | null },
): TrendResult {
  const now = opts.now ?? new Date();
  const { pubYear } = opts;
  const capped = new Set(opts.capped ?? []);
  const y = now.getUTCFullYear();
  const frac = yearFraction(now);
  const c = (yr: number) => counts[yr] ?? 0;

  if (pubYear !== null && pubYear >= y) {
    return { label: null, text: 'new paper', detail: 'Published this year, so there is no earlier year to compare with.' };
  }

  let recent: number, before: number, lead: string, beforeName: string, years: number[];
  if (opts.projected != null) {
    recent = opts.projected;
    before = c(y - 1);
    lead = `${y}: ~${fmt(recent)} projected`;
    beforeName = String(y - 1);
    years = [y, y - 1];
  } else if (frac >= PACE_MIN_YEAR_FRACTION) {
    recent = c(y) / frac;
    before = c(y - 1);
    lead = `${y} pace: ${fmt(recent)}`;
    beforeName = String(y - 1);
    years = [y, y - 1];
  } else if (pubYear === null || pubYear <= y - 2) {
    recent = c(y - 1);
    before = c(y - 2);
    lead = `${y - 1}: ${fmt(recent)}`;
    beforeName = String(y - 2);
    years = [y - 1, y - 2];
  } else {
    return { label: null, text: 'too new', detail: `Published ${pubYear}; a trend needs a full year of citations to compare.` };
  }
  if (years.some((yr) => capped.has(yr))) {
    return { label: null, text: 'trend n/a', detail: 'No trend: the years compared are past the 10,000 citation listing limit.' };
  }

  const diff = recent - before;
  let label: 'up' | 'flat' | 'down' = 'flat';
  if (recent >= UP_RATIO * before && diff >= MIN_ABS_CHANGE) label = 'up';
  else if (recent <= DOWN_RATIO * before && -diff >= MIN_ABS_CHANGE) label = 'down';

  const change = before > 0 ? `${diff >= 0 ? '+' : '−'}${Math.abs(Math.round((100 * diff) / before))}% on ${beforeName}` : `none in ${beforeName}`;
  const text = ({ up: 'trending up', flat: 'flat', down: 'trending down' } as const)[label];
  return { label, text, detail: `${lead}, ${change}` };
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** Rounds an axis maximum up to a round number with an even half (for the middle gridline). */
export function niceMax(v: number): number {
  if (v <= 1) return 2;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10]) if (m * p >= v && Number.isInteger((m * p) / 2)) return m * p;
  return 10 * p;
}
