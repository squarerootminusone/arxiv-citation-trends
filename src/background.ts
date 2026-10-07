// Fetches citing papers from Semantic Scholar and caches per-year and per-month counts.
// Runs in the service worker because host permissions bypass CORS there: the API's
// 429 replies carry no CORS header, so a page-side fetch could never see them to back off.
import { LIST_CAP, arxivYear, bucketCitations, type CitingRow } from './core.ts';
import { PORT_NAME, type CitationData, type CitationReply, type CitationRequest } from './types.ts';

const API = 'https://api.semanticscholar.org/graph/v1/paper/';
const CACHE_VERSION = 2;
/** Cached data younger than this is shown without refetching. */
const FRESH_MS = 24 * 3600 * 1000;
/** Older cached data is still shown at once, then replaced when the refetch lands. */
const STALE_MS = 30 * 24 * 3600 * 1000;
const PAGE = 1000;
/** Pages fetched at once. The anonymous limit is a shared pool, so a few parallel tries finish sooner. */
const CONCURRENCY = 3;
const MAX_ATTEMPTS = 30;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const CITE_FIELDS = 'year,publicationDate';

type Say = (text: string) => void;
type Emit = (data: CitationData) => void;

interface Row extends CitingRow {
  paperId?: string;
}
interface S2Paper {
  paperId?: string;
  title?: string;
  year?: number | null;
  citationCount?: number | null;
  citations?: Row[];
}
interface S2CitationPage {
  next?: number;
  data?: Array<{ citingPaper?: Row }>;
}

class NotFound extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function apiKey(): Promise<string> {
  try {
    const { s2ApiKey } = await chrome.storage.sync.get('s2ApiKey');
    return typeof s2ApiKey === 'string' ? s2ApiKey.trim() : '';
  } catch {
    return '';
  }
}

/**
 * GET with retry on 429/5xx. Retries come quickly (about 1 to 4 s): a 429 here means
 * the shared anonymous pool was full at that instant, not that this client is too fast.
 */
async function s2<T>(path: string, key: string, say: Say): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(API + path, { headers: key ? { 'x-api-key': key } : {} });
    } catch {
      res = null; // network error: retry like a 5xx
    }
    if (res?.ok) return (await res.json()) as T;
    if (res?.status === 404) throw new NotFound('Not on Semantic Scholar yet');
    if (res && !RETRY_STATUSES.has(res.status)) throw new Error(`Semantic Scholar returned HTTP ${res.status}`);
    const retryAfter = Number(res?.headers.get('retry-after'));
    const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(4000, 800 * 1.3 ** attempt) + Math.random() * 400;
    say(res?.status === 429 ? 'waiting for the API' : 'API busy, retrying');
    await sleep(wait);
  }
  throw new Error(
    key ? 'Semantic Scholar kept refusing requests' : 'Semantic Scholar is overloaded. A free API key in the extension options helps.',
  );
}

/** Runs `tasks` with at most `limit` in flight. */
async function pool(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

function citationsPath(id: string, offset: number, limit: number, yearFilter?: number): string {
  const filter = yearFilter === undefined ? '' : `&publicationDateOrYear=${yearFilter}`;
  return `arXiv:${encodeURIComponent(id)}/citations?fields=${CITE_FIELDS}&limit=${limit}&offset=${offset}${filter}`;
}

async function compute(id: string, say: Say, emit: Emit): Promise<CitationData> {
  const key = await apiKey();
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  say('asking Semantic Scholar');

  // One request returns the paper and its newest 1000 citations, which is
  // everything for most papers.
  const paper = await s2<S2Paper>(
    `arXiv:${encodeURIComponent(id)}?fields=title,year,citationCount,citations.${CITE_FIELDS.replace(',', ',citations.')}`,
    key,
    say,
  );
  const total = paper.citationCount ?? 0;
  const pubYear = paper.year ?? null;
  const axYear = arxivYear(id);
  const firstYear = Math.min(axYear ?? pubYear ?? currentYear, pubYear ?? axYear ?? currentYear);

  const snapshot = (rows: Iterable<Row>, complete: boolean, capped: number[] = [], extra?: Partial<CitationData>): CitationData => ({
    v: CACHE_VERSION,
    id,
    title: paper.title ?? '',
    pubYear,
    firstYear,
    total,
    ...bucketCitations(rows, firstYear, currentYear),
    capped,
    complete,
    fetchedAt: now.toISOString(),
    ...extra,
  });

  // Dedupe by paper id: page boundaries between the two endpoints can overlap.
  const byId = new Map<string, Row>();
  const anon: Row[] = [];
  const add = (r: Row | undefined) => {
    if (!r) return;
    if (r.paperId) byId.set(r.paperId, r);
    else anon.push(r);
  };
  const rows = () => [...byId.values(), ...anon];
  (paper.citations ?? []).forEach(add);

  if (total <= PAGE || (paper.citations ?? []).length < PAGE) return snapshot(rows(), true);

  if (total < LIST_CAP) {
    emit(snapshot(rows(), false));
    const tasks: Array<() => Promise<void>> = [];
    for (let offset = PAGE; offset < Math.min(total + PAGE, LIST_CAP); offset += PAGE) {
      const limit = Math.min(PAGE, LIST_CAP - offset);
      tasks.push(async () => {
        const page = await s2<S2CitationPage>(citationsPath(id, offset, limit), key, say);
        (page.data ?? []).forEach((d) => add(d.citingPaper));
        emit(snapshot(rows(), false));
      });
    }
    await pool(tasks, CONCURRENCY);
    return snapshot(rows(), true);
  }

  // Too many for one list: count each year on its own. A year at the cap is
  // detected with a single probe at the last listable slot.
  const perYear = new Map<number, Row[]>();
  const capped: number[] = [];
  const merged = () => [...perYear.values()].flat();
  const tasks: Array<() => Promise<void>> = [];
  for (let yr = currentYear; yr >= firstYear; yr--) {
    tasks.push(async () => {
      const probe = await s2<S2CitationPage>(citationsPath(id, LIST_CAP - 1, 1, yr), key, say);
      if ((probe.data ?? []).length > 0) {
        capped.push(yr);
        perYear.set(yr, new Array<Row>(LIST_CAP).fill({ year: yr }));
      } else {
        const got: Row[] = [];
        for (let offset = 0; ; offset += PAGE) {
          const page = await s2<S2CitationPage>(citationsPath(id, offset, Math.min(PAGE, LIST_CAP - offset), yr), key, say);
          const data = page.data ?? [];
          data.forEach((d) => d.citingPaper && got.push(d.citingPaper));
          if (page.next == null || data.length === 0) break;
        }
        perYear.set(yr, got);
      }
      emit(snapshot(merged(), false, [...capped]));
    });
  }
  await pool(tasks, CONCURRENCY);
  const listed = merged().length;
  const final = snapshot(merged(), true, capped.sort());
  // Citations the per-year lists never return (no year) are the gap to the total.
  if (!capped.length) final.excluded = Math.max(final.excluded, total - listed);
  return final;
}

async function fromCache(id: string): Promise<CitationData | null> {
  const k = `cit:${id}`;
  const got = await chrome.storage.local.get(k);
  const hit = got[k] as CitationData | undefined;
  if (hit && hit.v === CACHE_VERSION && Date.now() - Date.parse(hit.fetchedAt) < STALE_MS) return hit;
  return null;
}

/** One fetch per paper even when several tabs ask at once. */
const inflight = new Map<string, { job: Promise<CitationData>; listeners: Set<CitationReplyListener> }>();
type CitationReplyListener = (msg: CitationReply) => void;

function startJob(id: string) {
  let entry = inflight.get(id);
  if (!entry) {
    const listeners = new Set<CitationReplyListener>();
    const broadcast = (msg: CitationReply) => listeners.forEach((f) => f(msg));
    const job = compute(
      id,
      (text) => broadcast({ type: 'progress', text }),
      (data) => broadcast({ type: 'data', data }),
    )
      .then(async (data) => {
        await chrome.storage.local.set({ [`cit:${id}`]: data });
        return data;
      })
      .finally(() => inflight.delete(id));
    entry = { job, listeners };
    inflight.set(id, entry);
  }
  return entry;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
  });
  const post = (msg: CitationReply) => {
    if (open) port.postMessage(msg);
  };

  port.onMessage.addListener(async ({ id }: CitationRequest) => {
    let shown = false;
    try {
      const hit = await fromCache(id);
      if (hit) {
        post({ type: 'data', data: hit });
        shown = true;
        if (Date.now() - Date.parse(hit.fetchedAt) < FRESH_MS) return;
      }
      const { job, listeners } = startJob(id);
      // While a cached chart is on screen, skip partial snapshots and progress text.
      const listen: CitationReplyListener = (msg) => {
        if (!shown) post(msg);
      };
      listeners.add(listen);
      try {
        post({ type: 'data', data: await job });
      } finally {
        listeners.delete(listen);
      }
    } catch (e) {
      if (!shown) post({ type: 'error', message: e instanceof Error ? e.message : String(e), notFound: e instanceof NotFound });
    }
  });
});
