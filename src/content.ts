// Mounts the citations-per-year widget on arXiv abstract pages.
import { PLOT_LEFT, buildChart, chartModel, emptyChart, type ChartBar } from './chart.ts';
import { arxivIdFromPath, classifyTrend, fitYear } from './core.ts';
import { PORT_NAME, type CitationData, type CitationReply, type CitationRequest } from './types.ts';

const TREND_ICON = { up: '▲', flat: '▬', down: '▼' } as const;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function mountPoint(): { parent: Element; before: Node | null } | null {
  const side = document.querySelector('.extra-services');
  if (side) {
    // Below the "Access Paper" box so the download links stay on top.
    const access = side.querySelector(':scope > .full-text');
    return { parent: side, before: access ? access.nextSibling : side.firstChild };
  }
  const abs = document.querySelector('blockquote.abstract');
  if (abs?.parentElement) return { parent: abs.parentElement, before: abs.nextSibling };
  return null;
}

/** Text width in the chip's font, so the chart can keep bars out from under it. */
function textWidth(text: string, ref: Element): number {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return text.length * 7;
  ctx.font = `600 11.5px ${getComputedStyle(ref).fontFamily}`;
  return ctx.measureText(text).width;
}

class Widget {
  readonly root = h('div', 'act-box');
  private readonly title = h('h3', 'act-title', 'Citations');
  private readonly plot = h('div', 'act-plot');
  private readonly notes = h('div', 'act-notes');
  private readonly id: string;
  private port: chrome.runtime.Port | null = null;
  private rendered = false;

  constructor(id: string) {
    this.id = id;
    this.root.append(this.title, this.plot, this.notes);
  }

  load(): void {
    this.port?.disconnect();
    this.rendered = false;
    this.showLoading();
    const port = chrome.runtime.connect({ name: PORT_NAME });
    this.port = port;
    let finished = false;
    port.onMessage.addListener((msg: CitationReply) => {
      if (msg.type === 'data') {
        if (msg.data.complete) {
          finished = true;
          this.render(msg.data);
        } else if (!this.rendered) {
          this.title.textContent = `${fmt(msg.data.total)} citations`;
        }
      } else if (msg.type === 'error') {
        finished = true;
        if (!this.rendered) this.showError(msg.message, msg.notFound);
      }
    });
    port.onDisconnect.addListener(() => {
      if (!finished && !this.rendered && this.port === port) this.showError('Lost the connection to the extension.', false);
    });
    const req: CitationRequest = { id: this.id };
    port.postMessage(req);
  }

  /** The full chart frame with a spinner where the data will go. */
  private showLoading(): void {
    this.title.textContent = 'Citations';
    this.notes.replaceChildren();
    const overlay = h('div', 'act-overlay');
    overlay.append(h('span', 'act-spinner'));
    overlay.title = 'Loading citations from Semantic Scholar';
    this.plot.replaceChildren(emptyChart(new Date()), overlay);
  }

  private showError(message: string, notFound: boolean): void {
    const overlay = h('div', 'act-overlay act-error', message);
    if (!notFound) {
      const a = h('a', 'act-link', 'Retry');
      a.href = '#';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        this.load();
      });
      overlay.append(' ', a);
    }
    this.plot.replaceChildren(emptyChart(new Date()), overlay);
  }

  private render(data: CitationData): void {
    this.rendered = true;
    const now = new Date();
    const fit = fitYear(data, now);
    const totalText = `${fmt(data.total)} citations`;
    this.title.textContent = totalText;

    const trend = classifyTrend(data.counts, { now, pubYear: data.pubYear, capped: data.capped, projected: fit?.projected ?? null });
    const chip = h('span', `act-trend act-${trend.label ?? 'none'}`);
    chip.textContent = trend.label ? `${TREND_ICON[trend.label]} ${trend.text}` : trend.text;
    chip.title = trend.detail;

    const model = chartModel(data, fit, now);
    const describe = (b: ChartBar | null) => {
      if (!b) return totalText;
      const n = b.capped ? 'over 10,000' : fmt(b.count);
      if (b.projected !== null) return `${b.year}: ${n}, ~${fmt(b.projected)} by Dec`;
      return `${b.year}: ${n} citation${b.count === 1 ? '' : 's'}`;
    };
    const chipWidth = textWidth(chip.textContent, this.root) + 16;
    const { svg, chipSide } = buildChart(model, chipWidth, (b) => {
      this.title.textContent = describe(b);
    });
    chip.classList.add(chipSide === 'left' ? 'act-chip-left' : 'act-chip-right');
    if (chipSide === 'left') chip.style.left = `${PLOT_LEFT + 2}px`;
    this.plot.replaceChildren(svg, chip);

    this.notes.replaceChildren();
    if (data.capped.length) this.notes.append(h('div', '', 'Hatched years have over 10,000 citations, the most the API lists.'));
  }
}

function main(): void {
  const id = arxivIdFromPath(location.pathname);
  if (!id || document.querySelector('.act-box')) return;
  const at = mountPoint();
  if (!at) return;
  const w = new Widget(id);
  at.parent.insertBefore(w.root, at.before);
  w.load();
}

main();
