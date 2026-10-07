// Scholar-like bar chart with fixed bar spacing, a fitted monthly-rate curve and the
// projected end-of-year total as a dashed bar.
import { niceMax } from './core.ts';
import type { CitationData, YearFit } from './types.ts';

const SVG = 'http://www.w3.org/2000/svg';
const HEIGHT = 108;
const PAD_TOP = 8;
const PAD_BOTTOM = 17;
const SLOT = 32;
const BAR_W = 20;
const LABEL_GAP = 4;
const LABEL_W = 24;
/** Current year plus this many years back. */
export const YEARS_BACK = 5;

export interface ChartBar {
  year: number;
  count: number;
  partial: boolean;
  capped: boolean;
  projected: number | null;
}

export interface ChartModel {
  bars: ChartBar[];
  /** Dated citations before the first bar shown. */
  earlier: number;
  fit: YearFit | null;
}

export function chartModel(data: CitationData, fit: YearFit | null, now: Date): ChartModel {
  const currentYear = now.getUTCFullYear();
  const capped = new Set(data.capped);
  const dated = Object.keys(data.counts).map(Number).filter((y) => (data.counts[y] ?? 0) > 0);
  const first = Math.max(Math.min(data.firstYear, ...dated, currentYear), currentYear - YEARS_BACK);

  let earlier = 0;
  for (const y of dated) if (y < first) earlier += data.counts[y] ?? 0;

  const bars: ChartBar[] = [];
  for (let y = first; y <= currentYear; y++) {
    const partial = y === currentYear;
    bars.push({
      year: y,
      count: data.counts[y] ?? 0,
      partial,
      capped: capped.has(y),
      projected: partial && fit ? Math.round(fit.projected) : null,
    });
  }
  return { bars, earlier, fit };
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

/** Fitted curve points as (x, annualised rate); the extrapolated tail separately. */
function curvePoints(model: ChartModel): { past: Array<[number, number]>; future: Array<[number, number]> } {
  const fit = model.fit;
  const first = model.bars[0]?.year;
  if (!fit || first === undefined) return { past: [], future: [] };
  const xOf = (y: number, m: number) => (y - first) * SLOT + ((m + 0.5) / 12) * SLOT;
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

export function chartWidth(model: ChartModel): number {
  return model.bars.length * SLOT + LABEL_GAP + LABEL_W;
}

/** Builds the SVG. `onHover` gets a bar, or null when the pointer leaves. */
export function buildChart(model: ChartModel, onHover: (bar: ChartBar | null) => void): SVGSVGElement {
  const plotW = model.bars.length * SLOT;
  const width = chartWidth(model);
  const svg = el('svg', { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, class: 'act-chart', role: 'img' });
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const base = PAD_TOP + plotH;
  const curve = curvePoints(model);
  const peak = Math.max(
    1,
    ...model.bars.map((b) => Math.max(b.count, b.projected ?? 0)),
    ...curve.past.map((p) => p[1]),
    ...curve.future.map((p) => p[1]),
  );
  const max = niceMax(peak);
  const yOf = (v: number) => base - (v / max) * plotH;

  if (model.bars.some((b) => b.capped)) {
    const pattern = el('pattern', { id: 'act-hatch', width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pattern.append(el('rect', { width: 4, height: 4, class: 'act-hatch-bg' }), el('line', { x1: 0, y1: 0, x2: 0, y2: 4, class: 'act-hatch-line' }));
    const defs = el('defs', {});
    defs.append(pattern);
    svg.append(defs);
  }

  for (const f of [0, 0.5, 1]) {
    const yy = yOf(max * f);
    svg.append(el('line', { x1: 0, x2: plotW, y1: yy, y2: yy, class: f === 0 ? 'act-axis' : 'act-grid' }));
    const t = el('text', { x: plotW + LABEL_GAP, y: yy + 3.5, class: 'act-tick' });
    t.textContent = compact(max * f);
    svg.append(t);
  }

  model.bars.forEach((b, i) => {
    const cx = i * SLOT + SLOT / 2;
    const x = cx - BAR_W / 2;
    if (b.projected !== null && b.projected > b.count) {
      svg.append(el('rect', { x: x + 0.5, y: yOf(b.projected) + 0.5, width: BAR_W - 1, height: base - yOf(b.projected) - 0.5, class: 'act-projected' }));
    }
    const h = b.count > 0 ? Math.max(1, base - yOf(b.count)) : 0;
    const cls = b.capped ? 'act-bar act-capped' : b.partial ? 'act-bar act-partial' : 'act-bar';
    svg.append(el('rect', { x, y: base - h, width: BAR_W, height: h, class: cls }));
    const t = el('text', { x: cx, y: HEIGHT - 4, class: 'act-year' });
    t.textContent = String(b.year);
    svg.append(t);
  });

  const path = (pts: Array<[number, number]>) => pts.map(([x, v], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${yOf(v).toFixed(1)}`).join('');
  if (curve.past.length > 1) {
    const line = el('path', { d: path(curve.past), class: 'act-curve' });
    const tip = el('title', {});
    tip.textContent = 'Fitted monthly citation rate, annualised; dashed part is the projection';
    line.append(tip);
    svg.append(line);
  }
  if (curve.future.length > 1) svg.append(el('path', { d: path(curve.future), class: 'act-curve act-curve-future' }));

  // Full-height invisible hit areas so thin or empty bars are easy to hover.
  model.bars.forEach((b, i) => {
    const hit = el('rect', { x: i * SLOT, y: PAD_TOP, width: SLOT, height: plotH, class: 'act-hit' });
    hit.addEventListener('mouseenter', () => onHover(b));
    svg.append(hit);
  });
  svg.addEventListener('mouseleave', () => onHover(null));
  return svg;
}
