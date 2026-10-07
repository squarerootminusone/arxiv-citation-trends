// Scholar-like bar chart: five fixed-width year slots, y labels on the left, an
// S-curve fit of the monthly citation rate, and the projected rest of this year.
import { niceMax } from './core.ts';
import type { CitationData, YearFit } from './types.ts';

const SVG = 'http://www.w3.org/2000/svg';
export const YEARS = 5;
const HEIGHT = 112;
const PAD_TOP = 6;
const PAD_BOTTOM = 17;
const LABEL_W = 26;
const LABEL_GAP = 5;
const SLOT = 38;
const BAR_W = 24;
const PLOT_X = LABEL_W + LABEL_GAP;
export const CHART_WIDTH = PLOT_X + YEARS * SLOT;
/** The trend label overlays the top of the plot; bars under it are kept below this line. */
const CHIP_H = 18;

export interface ChartBar {
  year: number;
  count: number;
  partial: boolean;
  capped: boolean;
  projected: number | null;
}

export interface ChartModel {
  bars: ChartBar[];
  fit: YearFit | null;
}

/** The last five years, oldest first; years with no citations show as zero. */
export function chartYears(now: Date): number[] {
  const y = now.getUTCFullYear();
  return Array.from({ length: YEARS }, (_, i) => y - YEARS + 1 + i);
}

export function chartModel(data: CitationData, fit: YearFit | null, now: Date): ChartModel {
  const currentYear = now.getUTCFullYear();
  const capped = new Set(data.capped);
  const bars = chartYears(now).map((y) => ({
    year: y,
    count: data.counts[y] ?? 0,
    partial: y === currentYear,
    capped: capped.has(y),
    projected: y === currentYear && fit ? Math.round(fit.projected) : null,
  }));
  return { bars, fit };
}

export function compact(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

const xOfSlot = (i: number) => PLOT_X + i * SLOT;

/** Fitted curve points as (x, annualised rate); the extrapolated tail separately. */
function curvePoints(model: ChartModel): { past: Array<[number, number]>; future: Array<[number, number]> } {
  const fit = model.fit;
  const first = model.bars[0]?.year;
  if (!fit || first === undefined) return { past: [], future: [] };
  const xOf = (y: number, m: number) => xOfSlot(y - first) + ((m + 0.5) / 12) * SLOT;
  const past: Array<[number, number]> = [];
  fit.smooth.forEach((v, i) => {
    const idx = fit.startYear * 12 + fit.startMonth + i;
    const y = Math.floor(idx / 12);
    if (y >= first) past.push([xOf(y, idx % 12), v * 12]);
  });
  const lastIdx = fit.startYear * 12 + fit.startMonth + fit.smooth.length - 1;
  const future: Array<[number, number]> = past.length ? [past[past.length - 1]!] : [];
  fit.future.forEach((v, k) => {
    const idx = lastIdx + k + 1;
    future.push([xOf(Math.floor(idx / 12), idx % 12), v * 12]);
  });
  return { past, future };
}

const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
const BASE = PAD_TOP + plotH;

/** Empty frame: axis, year labels and faint gridlines. Used for loading and errors too. */
function frame(years: number[], max: number | null): SVGSVGElement {
  const svg = el('svg', { width: CHART_WIDTH, height: HEIGHT, viewBox: `0 0 ${CHART_WIDTH} ${HEIGHT}`, class: 'act-chart', role: 'img' });
  for (const f of [0, 0.5, 1]) {
    const yy = BASE - f * plotH;
    svg.append(el('line', { x1: PLOT_X, x2: CHART_WIDTH, y1: yy, y2: yy, class: f === 0 ? 'act-axis' : 'act-grid' }));
    if (max !== null) {
      const t = el('text', { x: LABEL_W, y: yy + 3.5, class: 'act-tick' });
      t.textContent = compact(max * f);
      svg.append(t);
    }
  }
  years.forEach((y, i) => {
    const t = el('text', { x: xOfSlot(i) + SLOT / 2, y: HEIGHT - 4, class: 'act-year' });
    t.textContent = String(y);
    svg.append(t);
  });
  return svg;
}

export function emptyChart(now: Date): SVGSVGElement {
  return frame(chartYears(now), null);
}

/**
 * Builds the chart. The trend label (`chipWidth` px wide) sits in whichever top
 * corner has lower bars; the axis maximum is raised if needed so nothing hides under it.
 */
export function buildChart(
  model: ChartModel,
  chipWidth: number,
  onHover: (bar: ChartBar | null) => void,
): { svg: SVGSVGElement; chipSide: 'left' | 'right' } {
  const curve = curvePoints(model);
  const n = model.bars.length;
  const span = Math.min(n, Math.ceil((chipWidth + 4) / SLOT));
  const peakIn = (from: number, to: number) => {
    const x0 = xOfSlot(from), x1 = xOfSlot(to);
    let p = 0;
    model.bars.slice(from, to).forEach((b) => (p = Math.max(p, b.count, b.projected ?? 0)));
    for (const [x, v] of [...curve.past, ...curve.future]) if (x >= x0 && x <= x1) p = Math.max(p, v);
    return p;
  };
  const leftPeak = peakIn(0, span);
  const rightPeak = peakIn(n - span, n);
  const chipSide = leftPeak <= rightPeak ? 'left' : 'right';
  const under = Math.min(leftPeak, rightPeak);
  const allPeak = Math.max(1, peakIn(0, n));
  const max = niceMax(Math.max(allPeak, (under * plotH) / (BASE - CHIP_H - 3)));
  const yOf = (v: number) => BASE - (v / max) * plotH;

  const svg = frame(model.bars.map((b) => b.year), max);

  if (model.bars.some((b) => b.capped)) {
    const pattern = el('pattern', { id: 'act-hatch', width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pattern.append(el('rect', { width: 4, height: 4, class: 'act-hatch-bg' }), el('line', { x1: 0, y1: 0, x2: 0, y2: 4, class: 'act-hatch-line' }));
    const defs = el('defs', {});
    defs.append(pattern);
    svg.prepend(defs);
  }

  model.bars.forEach((b, i) => {
    const x = xOfSlot(i) + (SLOT - BAR_W) / 2;
    if (b.projected !== null && b.projected > b.count) {
      svg.append(el('rect', { x, y: yOf(b.projected), width: BAR_W, height: yOf(b.count) - yOf(b.projected), class: 'act-projected' }));
    }
    const h = b.count > 0 ? Math.max(1, BASE - yOf(b.count)) : 0;
    svg.append(el('rect', { x, y: BASE - h, width: BAR_W, height: h, class: b.capped ? 'act-bar act-capped' : 'act-bar' }));
  });

  const path = (pts: Array<[number, number]>) => pts.map(([x, v], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${yOf(v).toFixed(1)}`).join('');
  if (curve.past.length > 1) {
    const line = el('path', { d: path(curve.past), class: 'act-curve' });
    const tip = el('title', {});
    tip.textContent = 'S-curve fit of the monthly citation rate, annualised; dashed part is the projection';
    line.append(tip);
    svg.append(line);
  }
  if (curve.future.length > 1) svg.append(el('path', { d: path(curve.future), class: 'act-curve act-curve-future' }));

  // Full-height invisible hit areas so thin or empty bars are easy to hover.
  model.bars.forEach((b, i) => {
    const hit = el('rect', { x: xOfSlot(i), y: PAD_TOP, width: SLOT, height: plotH, class: 'act-hit' });
    hit.addEventListener('mouseenter', () => onHover(b));
    svg.append(hit);
  });
  svg.addEventListener('mouseleave', () => onHover(null));
  return { svg, chipSide };
}

export const PLOT_LEFT = PLOT_X;
