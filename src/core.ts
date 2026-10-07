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

/** Smoothing strength for the monthly curve; roughly a 3 to 4 month window. */
const SMOOTH_LAMBDA = 1500;
/** Damping of slope and curvature when extrapolating, per month. */
const SLOPE_DAMP = 0.92;
const CURVE_DAMP = 0.7;
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

/**
 * Whittaker-Henderson smoother: minimises |y - z|^2 + lambda |D z|^2 where D takes
 * `order`-th differences. Order 3 keeps slope and curvature free and penalises only
 * changes in curvature, so the ends behave like a local quadratic.
 */
export function whittaker(y: readonly number[], lambda: number, order = 3): number[] {
  const n = y.length;
  if (n <= order) return [...y];
  // Difference coefficients, e.g. order 3: [-1, 3, -3, 1].
  let coef = [1];
  for (let k = 0; k < order; k++) {
    const next = new Array<number>(coef.length + 1).fill(0);
    coef.forEach((c, i) => {
      next[i] = (next[i] ?? 0) - c;
      next[i + 1] = (next[i + 1] ?? 0) + c;
    });
    coef = next;
  }
  // A = I + lambda * D^T D (dense; n is at most a few hundred).
  const A: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let r = 0; r + order < n; r++) {
    for (let a = 0; a <= order; a++) {
      for (let b = 0; b <= order; b++) {
        A[r + a]![r + b]! += lambda * coef[a]! * coef[b]!;
      }
    }
  }
  // Cholesky solve.
  const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - order); j <= i; j++) {
      let s = A[i]![j]!;
      for (let k = Math.max(0, i - order); k < j; k++) s -= L[i]![k]! * L[j]![k]!;
      L[i]![j] = i === j ? Math.sqrt(s) : s / L[j]![j]!;
    }
  }
  const t = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = y[i]!;
    for (let k = Math.max(0, i - order); k < i; k++) s -= L[i]![k]! * t[k]!;
    t[i] = s / L[i]![i]!;
  }
  const z = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = t[i]!;
    for (let k = i + 1; k <= Math.min(n - 1, i + order); k++) s -= L[k]![i]! * z[k]!;
    z[i] = s / L[i]![i]!;
  }
  return z;
}

/**
 * Fits a smooth monthly citation rate and extrapolates it to December.
 * Months use dated citations only, scaled per year so each year's months add up to
 * that year's full count. The current, partial month is left out of the fit.
 * The extrapolation continues the curve's last slope and curvature, both damped.
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

  const z = whittaker(series, SMOOTH_LAMBDA, 3);
  const smooth = z.map((v) => Math.max(0, v));
  const zn = z[n - 1]!, z1 = z[n - 2]!, z2 = z[n - 3]!;
  let slope = zn - z1;
  const curve = zn - 2 * z1 + z2;
  let rate = Math.max(0, zn);

  const remaining = endY < Y ? 12 : 11 - endM;
  const future: number[] = [];
  for (let k = 1; k <= remaining; k++) {
    slope = SLOPE_DAMP * slope + curve * CURVE_DAMP ** k;
    rate = Math.max(0, rate + slope);
    future.push(rate);
  }

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

/** Rounds an axis maximum up to 1, 2 or 5 times a power of ten. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
