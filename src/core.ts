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
 * One observation: a citation count summed over some months. `cells` lists
 * (month index, fraction of that month) pairs; a single month is [[t, 1]], a year
 * is twelve cells, and the current month counts only the part that has passed.
 * The model rate is evaluated at month midpoints.
 */
export interface Obs {
  cells: Array<[number, number]>;
  y: number;
  w: number;
}

/**
 * Fits rate(t) = b + K * sigmoid(k (t - t0)) to interval counts by weighted least
 * squares. For fixed (k, t0) every observation is linear in (b, K), so those are
 * solved exactly while k and t0 are searched on a grid, then refined on a finer
 * one. The rate is kept at or above zero over months [0, span).
 */
export function fitSCurve(obs: readonly Obs[], span: number): SCurve | null {
  if (obs.length < 2 || span < 2) return null;
  let best: (SCurve & { sse: number }) | null = null;

  const tryFit = (k: number, t0: number) => {
    const sig = (t: number) => sigmoid(k * (t + 0.5 - t0));
    let sLL = 0, sLG = 0, sGG = 0, sLY = 0, sGY = 0;
    const L: number[] = [], G: number[] = [];
    for (const o of obs) {
      let l = 0, g = 0;
      for (const [t, f] of o.cells) {
        l += f;
        g += f * sig(t);
      }
      L.push(l);
      G.push(g);
      sLL += o.w * l * l; sLG += o.w * l * g; sGG += o.w * g * g; sLY += o.w * l * o.y; sGY += o.w * g * o.y;
    }
    const det = sLL * sGG - sLG * sLG;
    let b: number, K: number;
    if (Math.abs(det) > 1e-12 * sLL * sGG) {
      b = (sGG * sLY - sLG * sGY) / det;
      K = (sLL * sGY - sLG * sLY) / det;
    } else {
      b = sLY / sLL;
      K = 0;
    }
    // Keep the rate non-negative over the whole span: sigmoid is monotone, so check the ends.
    const s0 = sig(0), s1 = sig(span - 1);
    const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
    if (b + K * lo < 0 || b + K * hi < 0) {
      // Pin the low end of the S at zero: rate = K (sigmoid - sLow).
      const sl = K >= 0 ? lo : hi;
      let num = 0, den = 0;
      obs.forEach((o, j) => {
        const d = G[j]! - sl * L[j]!;
        num += o.w * d * o.y;
        den += o.w * d * d;
      });
      K = den > 0 ? num / den : 0;
      b = -K * sl;
    }
    let sse = 0;
    obs.forEach((o, j) => {
      const r = o.y - (b * L[j]! + K * G[j]!);
      sse += o.w * r * r;
    });
    if (!best || sse < best.sse) best = { b, K, k, t0, sse };
  };

  const ks = [0.02, 0.035, 0.05, 0.07, 0.1, 0.14, 0.2, 0.28, 0.4];
  for (const k of ks) for (let t0 = -24; t0 <= span + 24; t0 += 1) tryFit(k, t0);
  const coarse = best as (SCurve & { sse: number }) | null;
  if (!coarse) return null;
  for (let f = 0.7; f <= 1.45; f += 0.05) {
    for (let d = -1.5; d <= 1.5; d += 0.25) tryFit(coarse.k * f, coarse.t0 + d);
  }
  const { b, K, k, t0 } = best as unknown as SCurve;
  return { b, K, k, t0 };
}

const recency = (monthsAgo: number) => 0.5 ** (monthsAgo / 24);

/**
 * Fits an S-curve to the citation rate and extrapolates it to December.
 *
 * With complete monthly data, each month is one observation. Months use dated
 * citations only, scaled per year so each year's months add up to that year's full
 * count, and the current partial month is left out.
 *
 * With only yearly totals (very highly cited papers), each full year is one
 * observation and this year so far is another, covering the elapsed fraction.
 *
 * Weights treat counts as Poisson-like and favour recent data (2-year half-life).
 * An S-curve rises (or falls) and then levels off, so the extrapolation cannot run away.
 */
export function fitYear(
  data: {
    counts: Record<number, number>;
    months: Record<string, number>;
    monthsComplete: boolean;
    capped: readonly number[];
    firstYear: number;
  },
  now: Date,
): YearFit | null {
  const Y = now.getUTCFullYear();
  const M = now.getUTCMonth();
  if (data.capped.includes(Y) || data.capped.includes(Y - 1)) return null;
  const nowIdx = Y * 12 + M;
  const monthStart = Date.UTC(Y, M, 1);
  const elapsed = (now.getTime() - monthStart) / (Date.UTC(Y, M + 1, 1) - monthStart);
  const firstIdx = Math.max(data.firstYear * 12, (Y - 7) * 12);

  if (data.monthsComplete) {
    const monthsSum = (y: number) => {
      let s = 0;
      for (let m = 0; m < 12; m++) s += data.months[monthKey(y, m)] ?? 0;
      return s;
    };
    const scaleCache = new Map<number, number>();
    const scale = (y: number) => {
      let v = scaleCache.get(y);
      if (v === undefined) {
        const dated = monthsSum(y);
        // Yearly totals can come from a different index than the dates, so allow either direction.
        v = dated > 0 ? Math.min(2, Math.max(0.5, (data.counts[y] ?? 0) / dated)) : 1;
        scaleCache.set(y, v);
      }
      return v;
    };
    const endIdx = nowIdx - 1; // last complete month
    let startIdx = firstIdx;
    while (startIdx <= endIdx && (data.months[monthKey(Math.floor(startIdx / 12), startIdx % 12)] ?? 0) === 0) startIdx++;
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
    const obs: Obs[] = series.map((v, i) => {
      const lo = Math.max(0, i - 1), hi = Math.min(n - 1, i + 1);
      let m = 0;
      for (let j = lo; j <= hi; j++) m += series[j]!;
      m /= hi - lo + 1;
      return { cells: [[i, 1]], y: v, w: recency(n - 1 - i) / Math.max(2, m) };
    });
    const curve = fitSCurve(obs, n);
    if (!curve) return null;
    const smooth = series.map((_, i) => scurveAt(curve, i));
    const future: number[] = [];
    for (let i = endIdx + 1; i <= Y * 12 + 11; i++) future.push(scurveAt(curve, i - startIdx));
    let soFar = 0;
    for (let i = Math.max(startIdx, Y * 12); i <= endIdx; i++) soFar += data.months[monthKey(Y, i % 12)] ?? 0;
    const projected = Math.max(data.counts[Y] ?? 0, soFar * scale(Y) + future.reduce((a, b) => a + b, 0));
    return { startYear: Math.floor(startIdx / 12), startMonth: startIdx % 12, smooth, future, projected };
  }

  // Yearly totals only.
  let startYear = Math.floor(firstIdx / 12);
  while (startYear < Y && (data.counts[startYear] ?? 0) === 0) startYear++;
  const startIdx = startYear * 12;
  const span = nowIdx - startIdx + 1;
  let raw = 0;
  const obs: Obs[] = [];
  for (let y = startYear; y <= Y; y++) {
    const v = data.counts[y] ?? 0;
    raw += v;
    const cells: Array<[number, number]> = [];
    const lastM = y === Y ? M : 11;
    for (let m = 0; m <= lastM; m++) cells.push([y * 12 + m - startIdx, y === Y && m === M ? elapsed : 1]);
    const mid = cells.reduce((a, [t, f]) => a + t * f, 0) / cells.reduce((a, [, f]) => a + f, 0);
    obs.push({ cells, y: v, w: recency(span - 1 - mid) / Math.max(2, v) });
  }
  if (obs.length < 2 || raw < FIT_MIN_CITATIONS) return null;
  const curve = fitSCurve(obs, span);
  if (!curve) return null;
  const smooth: number[] = [];
  for (let i = startIdx; i < nowIdx; i++) smooth.push(scurveAt(curve, i - startIdx));
  const future: number[] = [];
  for (let i = nowIdx; i <= Y * 12 + 11; i++) future.push(scurveAt(curve, i - startIdx));
  const rest = (1 - elapsed) * (future[0] ?? 0) + future.slice(1).reduce((a, b) => a + b, 0);
  const projected = (data.counts[Y] ?? 0) + rest;
  return { startYear, startMonth: 0, smooth, future, projected };
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
