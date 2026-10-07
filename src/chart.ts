// Google Scholar style bar chart: grey bars, years underneath, gridline labels on the right.
import { niceMax } from './core.ts';
import type { CitationData } from './types.ts';

const SVG = 'http://www.w3.org/2000/svg';
const HEIGHT = 112;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;
const PAD_RIGHT = 34;
const MIN_SLOT = 13;
const MAX_BARS = 16;

export interface ChartBar {
  year: number;
  count: number;
  partial: boolean;
  capped: boolean;
}

export interface ChartModel {
  bars: ChartBar[];
  /** Dated citations before the first bar shown. */
  earlier: number;
}

export function chartModel(data: CitationData, width: number, now: Date): ChartModel {
  const currentYear = now.getUTCFullYear();
  const capped = new Set(data.capped);
  const dated = Object.keys(data.counts).map(Number).filter((y) => (data.counts[y] ?? 0) > 0);
  let first = Math.min(data.pubYear ?? currentYear, ...dated, currentYear);
  const fit = Math.max(4, Math.min(MAX_BARS, Math.floor((width - PAD_RIGHT) / MIN_SLOT)));
  first = Math.max(first, currentYear - fit + 1);

  let earlier = 0;
  for (const y of dated) if (y < first) earlier += data.counts[y] ?? 0;

  const bars: ChartBar[] = [];
  for (let y = first; y <= currentYear; y++) {
    bars.push({ year: y, count: data.counts[y] ?? 0, partial: y === currentYear, capped: capped.has(y) });
  }
  return { bars, earlier };
}

export function compact(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Builds the SVG. `onHover` gets a bar, or null when the pointer leaves. */
export function buildChart(model: ChartModel, width: number, onHover: (bar: ChartBar | null) => void): SVGSVGElement {
  const svg = el('svg', { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, class: 'act-chart', role: 'img' });
  const plotW = width - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const base = PAD_TOP + plotH;
  const max = niceMax(Math.max(1, ...model.bars.map((b) => b.count)));

  // Hatching marks years over the API's list cap: their true height is unknown.
  if (model.bars.some((b) => b.capped)) {
    const pattern = el('pattern', { id: 'act-hatch', width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pattern.append(el('rect', { width: 4, height: 4, class: 'act-hatch-bg' }), el('line', { x1: 0, y1: 0, x2: 0, y2: 4, class: 'act-hatch-line' }));
    const defs = el('defs', {});
    defs.append(pattern);
    svg.append(defs);
  }

  // Gridlines at 0, max/2 and max, labelled on the right like Scholar.
  for (const f of [0, 0.5, 1]) {
    const yy = base - f * plotH;
    svg.append(el('line', { x1: 0, x2: plotW, y1: yy, y2: yy, class: f === 0 ? 'act-axis' : 'act-grid' }));
    const t = el('text', { x: plotW + 5, y: yy + 3.5, class: 'act-tick' });
    t.textContent = compact(max * f);
    svg.append(t);
  }

  const slot = plotW / model.bars.length;
  const barW = Math.max(3, Math.min(18, slot * 0.62));
  const labelEvery = Math.ceil(28 / slot);
  const last = model.bars.length - 1;

  model.bars.forEach((b, i) => {
    const cx = i * slot + slot / 2;
    const h = b.count > 0 ? Math.max(1, (b.count / max) * plotH) : 0;
    const cls = b.capped ? 'act-bar act-capped' : b.partial ? 'act-bar act-partial' : 'act-bar';
    svg.append(el('rect', { x: cx - barW / 2, y: base - h, width: barW, height: h, class: cls }));
    if ((last - i) % labelEvery === 0) {
      const t = el('text', { x: cx, y: HEIGHT - 4, class: 'act-year' });
      t.textContent = slot < 24 ? `'${String(b.year).slice(2)}` : String(b.year);
      svg.append(t);
    }
    // Full-height invisible hit area so thin or empty bars are easy to hover.
    const hit = el('rect', { x: i * slot, y: PAD_TOP, width: slot, height: plotH, class: 'act-hit' });
    hit.addEventListener('mouseenter', () => onHover(b));
    svg.append(hit);
  });
  svg.addEventListener('mouseleave', () => onHover(null));
  return svg;
}
