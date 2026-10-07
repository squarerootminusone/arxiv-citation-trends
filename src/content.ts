// Mounts the citations-per-year widget on arXiv abstract pages.
import { buildChart, chartModel, type ChartBar } from './chart.ts';
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

class Widget {
  readonly root = h('div', 'act-box');
  private readonly title = h('span', 'act-title', 'Citations');
  private readonly head = h('div', 'act-head');
  private readonly body = h('div', 'act-body');
  private readonly id: string;
  private port: chrome.runtime.Port | null = null;
  private rendered = false;

  constructor(id: string) {
    this.id = id;
    this.head.append(this.title);
    this.root.append(this.head, this.body);
  }

  load(): void {
    this.port?.disconnect();
    this.rendered = false;
    this.showStatus('Loading…');
    const port = chrome.runtime.connect({ name: PORT_NAME });
    this.port = port;
    let finished = false;
    port.onMessage.addListener((msg: CitationReply) => {
      if (msg.type === 'progress') {
        if (!this.rendered) this.showStatus(`Loading… ${msg.text}`);
      } else if (msg.type === 'data') {
        if (msg.data.complete) finished = true;
        this.render(msg.data);
      } else {
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

  private setChip(chip: HTMLElement | null): void {
    this.head.querySelector('.act-trend')?.remove();
    if (chip) this.head.append(chip);
  }

  private showStatus(text: string): void {
    this.title.textContent = 'Citations';
    this.setChip(null);
    this.body.replaceChildren(h('div', 'act-status', text));
  }

  private showError(message: string, notFound: boolean): void {
    this.setChip(null);
    const box = h('div', 'act-status act-error', message);
    if (!notFound) {
      const a = h('a', 'act-link', 'Retry');
      a.href = '#';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        this.load();
      });
      box.append(' ', a);
    }
    this.body.replaceChildren(box);
  }

  private render(data: CitationData): void {
    this.rendered = true;
    const now = new Date();
    const fit = data.complete ? fitYear(data, now) : null;
    const totalText = `${fmt(data.total)} citations`;
    this.title.textContent = totalText;

    let chip: HTMLElement;
    let detail = '';
    if (data.complete) {
      const trend = classifyTrend(data.counts, { now, pubYear: data.pubYear, capped: data.capped, projected: fit?.projected ?? null });
      chip = h('span', `act-trend act-${trend.label ?? 'none'}`);
      chip.textContent = trend.label ? `${TREND_ICON[trend.label]} ${trend.text}` : trend.text;
      chip.title = trend.detail;
      detail = trend.detail;
    } else {
      chip = h('span', 'act-trend act-none', 'loading…');
    }
    this.setChip(chip);

    const model = chartModel(data, fit, now);
    const describe = (b: ChartBar | null) => {
      if (!b) return totalText;
      const n = b.capped ? 'over 10,000' : fmt(b.count);
      if (b.projected !== null) return `${b.year}: ${n}, ~${fmt(b.projected)} by Dec`;
      return `${b.year}: ${n} citation${b.count === 1 ? '' : 's'}`;
    };
    const svg = buildChart(model, (b) => {
      this.title.textContent = describe(b);
      // The hovered year's readout gets the full header width.
      chip.style.display = b ? 'none' : '';
    });

    const notes = h('div', 'act-notes');
    if (detail) notes.append(h('div', '', detail));
    if (model.earlier > 0) notes.append(h('div', '', `Plus ${fmt(model.earlier)} before ${model.bars[0]?.year}.`));
    if (data.capped.length) notes.append(h('div', '', 'Hatched years have over 10,000 citations, the most the API lists.'));
    this.body.replaceChildren(svg, notes);
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
