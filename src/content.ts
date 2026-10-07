// Mounts the citations-per-year widget on arXiv abstract pages.
import { buildChart, chartModel, type ChartBar } from './chart.ts';
import { arxivIdFromPath, classifyTrend } from './core.ts';
import { PORT_NAME, type CitationData, type CitationReply, type CitationRequest } from './types.ts';

const TREND_ICON = { up: '▲', flat: '▬', down: '▼' } as const;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function ago(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  return hr < 48 ? `${hr} h ago` : `${Math.round(hr / 24)} d ago`;
}

function mountPoint(): { parent: Element; before: Node | null } | null {
  const side = document.querySelector('.extra-services');
  if (side) {
    // Below the "Access Paper" links so the download links stay on top.
    const access = side.querySelector(':scope > .full-text');
    return { parent: side, before: access ? access.nextSibling : side.firstChild };
  }
  const abs = document.querySelector('blockquote.abstract');
  if (abs?.parentElement) return { parent: abs.parentElement, before: abs.nextSibling };
  return null;
}

class Widget {
  readonly root = h('div', 'act-box');
  private readonly head = h('div', 'act-head');
  private readonly body = h('div', 'act-body');
  private readonly foot = h('div', 'act-foot');
  private readonly id: string;
  private port: chrome.runtime.Port | null = null;

  constructor(id: string) {
    this.id = id;
    this.head.append(h('span', 'act-title', 'Citations per year'));
    this.root.append(this.head, this.body, this.foot);
  }

  load(force = false): void {
    this.port?.disconnect();
    this.showStatus('Loading citations…');
    this.foot.replaceChildren();
    const port = chrome.runtime.connect({ name: PORT_NAME });
    this.port = port;
    let finished = false;
    port.onMessage.addListener((msg: CitationReply) => {
      if (msg.type === 'progress') this.showStatus(`Loading citations… ${msg.text}`);
      else if (msg.type === 'done') {
        finished = true;
        this.render(msg.data);
      } else {
        finished = true;
        this.showError(msg.message, msg.notFound);
      }
    });
    port.onDisconnect.addListener(() => {
      if (!finished && this.port === port) this.showError('Lost the connection to the extension.', false);
    });
    const req: CitationRequest = { id: this.id, force };
    port.postMessage(req);
  }

  private setTrend(chip: HTMLElement | null): void {
    this.head.querySelector('.act-trend')?.remove();
    if (chip) this.head.append(chip);
  }

  private showStatus(text: string): void {
    this.setTrend(null);
    this.body.replaceChildren(h('div', 'act-status', text));
  }

  private showError(message: string, notFound: boolean): void {
    this.setTrend(null);
    const box = h('div', 'act-status act-error', message);
    if (!notFound) box.append(' ', this.link('Retry', () => this.load(true)));
    this.body.replaceChildren(box);
  }

  private link(text: string, onClick: () => void): HTMLAnchorElement {
    const a = h('a', 'act-link', text);
    a.href = '#';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    return a;
  }

  private render(data: CitationData): void {
    const now = new Date();
    const trend = classifyTrend(data.counts, { now, pubYear: data.pubYear, capped: data.capped });
    const chip = h('span', `act-trend act-${trend.label ?? 'none'}`);
    chip.textContent = trend.label ? `${TREND_ICON[trend.label]} ${trend.text}` : trend.text;
    chip.title = trend.detail;
    this.setTrend(chip);

    const width = Math.max(180, Math.min(420, Math.floor(this.root.clientWidth || 240)));
    const model = chartModel(data, width, now);
    const totalText = `${data.total.toLocaleString()} citations in total`;
    const readout = h('div', 'act-readout', totalText);
    const describe = (b: ChartBar | null) => {
      if (!b) return totalText;
      const n = b.capped ? 'over 10,000' : b.count.toLocaleString();
      return `${b.year}: ${n} citation${b.count === 1 ? '' : 's'}${b.partial ? ' so far' : ''}`;
    };
    const svg = buildChart(model, width, (b) => {
      readout.textContent = describe(b);
    });

    const notes = h('div', 'act-notes');
    notes.append(h('div', '', trend.detail));
    const extra: string[] = [];
    if (model.earlier > 0) extra.push(`${model.earlier.toLocaleString()} before ${model.bars[0]?.year}`);
    if (data.undated) extra.push(`${data.undated.toLocaleString()} undated`);
    if (extra.length) notes.append(h('div', '', `Not shown: ${extra.join(', ')}.`));
    if (data.capped.length) notes.append(h('div', '', 'Hatched years have over 10,000 citations, the most the API lists.'));
    this.body.replaceChildren(readout, svg, notes);

    const src = h('a', 'act-link', 'Semantic Scholar');
    src.href = data.s2Url ?? `https://www.semanticscholar.org/arxiv/${data.id}`;
    src.target = '_blank';
    src.rel = 'noopener';
    this.foot.replaceChildren(src, ` · ${ago(data.fetchedAt)} · `, this.link('refresh', () => this.load(true)));
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
