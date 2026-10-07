// Pure helpers shared by the background worker, the content script and the tests.
import type { TrendResult } from './types.ts';

/** Semantic Scholar refuses offset + limit >= 10000 on the citations list. */
export const LIST_CAP = 9999;

const UP_RATIO = 1.2;
const DOWN_RATIO = 0.8;
/** Citations per year; keeps tiny counts from flapping between labels. */
const MIN_ABS_CHANGE = 3;
/** Use this year's annualised pace only once half the year has passed. */
const PACE_MIN_YEAR_FRACTION = 0.5;

/** "/abs/2010.08895v3" -> "2010.08895"; old-style ids like "/abs/hep-th/9901001v2" too. */
export function arxivIdFromPath(pathname: string): string | null {
  const m = /^\/abs\/(.+?)\/?$/.exec(pathname);
  if (!m || !m[1]) return null;
  const id = decodeURIComponent(m[1]).replace(/v\d+$/, '');
  if (/^\d{4}\.\d{4,5}$/.test(id)) return id;
  if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}$/.test(id)) return id;
  return null;
}

/**
 * Buckets citing-paper years. Years after `currentYear` are index errors and,
 * like missing years, count as undated.
 */
export function bucketYears(
  years: ReadonlyArray<number | null | undefined>,
  currentYear: number,
): { counts: Record<number, number>; undated: number } {
  const counts: Record<number, number> = {};
  let undated = 0;
  for (const y of years) {
    if (typeof y !== 'number' || !Number.isInteger(y) || y > currentYear) {
      undated++;
      continue;
    }
    counts[y] = (counts[y] ?? 0) + 1;
  }
  return { counts, undated };
}

export function yearFraction(now: Date): number {
  const y = now.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return (now.getTime() - start) / (end - start);
}

/**
 * Labels the citation trend. From July on it compares this year's annualised pace
 * with last year; before that it compares the last two full years. "Up" and "down"
 * need a 20% change and at least 3 citations a year of difference.
 */
export function classifyTrend(
  counts: Record<number, number>,
  opts: { now?: Date; pubYear: number | null; capped?: readonly number[] },
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

  let recent: number, before: number, recentName: string, beforeName: string, years: number[];
  if (frac >= PACE_MIN_YEAR_FRACTION) {
    recent = c(y) / frac;
    before = c(y - 1);
    recentName = `${y} pace`;
    beforeName = String(y - 1);
    years = [y, y - 1];
  } else if (pubYear === null || pubYear <= y - 2) {
    recent = c(y - 1);
    before = c(y - 2);
    recentName = String(y - 1);
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

  const pct = before > 0 ? `${diff >= 0 ? '+' : ''}${Math.round((100 * diff) / before)}%` : 'from 0';
  const text = ({ up: 'trending up', flat: 'flat', down: 'trending down' } as const)[label];
  return { label, text, detail: `${recentName}: ${Math.round(recent)} vs ${beforeName}: ${before} (${pct})` };
}

/** Rounds an axis maximum up to 1, 2 or 5 times a power of ten. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
