// Fetches citing papers from Semantic Scholar and caches per-year and per-month counts.
// Runs in the service worker because host permissions bypass CORS there: the API's
// 429 replies carry no CORS header, so a page-side fetch could never see them to back off.
import { LIST_CAP, arxivYear, bucketCitations, type CitingRow } from './core.ts';
import { PORT_NAME, type CitationData, type CitationReply, type CitationRequest } from './types.ts';

const API = 'https://api.semanticscholar.org/graph/v1/paper/';
const CACHE_VERSION = 3;
/** Cached data younger than this is shown without refetching. */
const FRESH_MS = 24 * 3600 * 1000;
/** Older cached data is still shown at once, then replaced when the refetch lands. */
const STALE_MS = 30 * 24 * 3600 * 1000;
const PAGE = 1000;
/** Pages fetched at once. The anonymous limit is a shared pool, so a few parallel tries finish sooner. */
const CONCURRENCY = 3;
/** With an API key the limit is 1 request per second for this key: go one at a time, spaced out. */
const KEYED_CONCURRENCY = 1;
const KEYED_INTERVAL_MS = 1100;
/** Exponential backoff: 1 s, 2 s, 4 s ... capped at 32 s, with jitter; about 2 minutes in total. */
const MAX_ATTEMPTS = 9;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 32_000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const CITE_FIELDS = 'year,publicationDate';
/**
 * Semantic Scholar's website endpoint. Undocumented and outside the public API (and
 * its key), but it returns exact citations per year in one request with no 10k cap.
 * Everything falls back to the public API when it fails.
 */
const SITE_API = 'https://www.semanticscholar.org/api/1/paper/';

interface SitePaper {
  paper?: { citationStats?: { citedByBuckets?: Array<{ startKey?: number; endKey?: number; count?: number }> } };
}

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

/** Start time of the last keyed request, shared by every job in this worker. */
let lastKeyedStart = 0;
async function paceKeyed(): Promise<void> {
  const wait = lastKeyedStart + KEYED_INTERVAL_MS - Date.now();
  lastKeyedStart = Math.max(Date.now(), lastKeyedStart + KEYED_INTERVAL_MS);
  if (wait > 0) await sleep(wait);
}

/**
 * Shared backoff: when any request is refused, every request in this worker waits
 * until this time, so parallel pages do not keep hitting an overloaded API.
 */
let backoffUntil = 0;

/** Exponential backoff with "equal jitter": half the step fixed, half random. */
function backoffMs(attempt: number): number {
  const step = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return step / 2 + Math.random() * (step / 2);
}

/** GET from the Graph API (keyed if a key is set). */
function s2<T>(path: string, key: string, say: Say): Promise<T> {
  return getJson<T>(API + path, key, say);
}

/** GET with exponential backoff on 429/5xx and network errors; honours Retry-After. */
async function getJson<T>(url: string, key: string, say: Say): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const hold = backoffUntil - Date.now();
    if (hold > 0) await sleep(hold);
    if (key) await paceKeyed();
    let res: Response | null = null;
    try {
      res = await fetch(url, { headers: key ? { 'x-api-key': key } : {} });
    } catch {
      res = null; // network error: retry like a 5xx
    }
    if (res?.ok) return (await res.json()) as T;
    if (res?.status === 404) throw new NotFound('Not on Semantic Scholar yet');
    if (res && !RETRY_STATUSES.has(res.status)) throw new Error(`Semantic Scholar returned HTTP ${res.status}`);
    const retryAfter = Number(res?.headers.get('retry-after'));
    const wait = retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
    backoffUntil = Math.max(backoffUntil, Date.now() + wait);
    say(res?.status === 429 ? 'waiting for the API' : 'API busy, retrying');
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

/** What never changes for a paper: Semantic Scholar's id and metadata, cached for good. */
interface PaperMeta {
  paperId: string;
  title: string;
  pubYear: number | null;
  total: number;
}

async function loadMeta(id: string): Promise<PaperMeta | null> {
  const got = await chrome.storage.local.get(`meta:${id}`);
  return (got[`meta:${id}`] as PaperMeta | undefined) ?? null;
}

async function compute(id: string, say: Say, emit: Emit): Promise<CitationData> {
  const key = await apiKey();
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const axYear = arxivYear(id);
  let meta = await loadMeta(id);
  const firstYearOf = (pubYear: number | null) => Math.min(axYear ?? pubYear ?? currentYear, pubYear ?? axYear ?? currentYear);

  const snapshot = (
    m: { title: string; pubYear: number | null; total: number },
    rows: Iterable<Row>,
    opts: { complete: boolean; monthsComplete: boolean; capped?: number[]; counts?: Record<number, number> },
  ): CitationData => {
    const firstYear = firstYearOf(m.pubYear);
    const b = bucketCitations(rows, firstYear, currentYear);
    const counts = opts.counts ?? b.counts;
    const listed = Object.values(counts).reduce((x, y) => x + y, 0);
    return {
      v: CACHE_VERSION,
      id,
      title: m.title,
      pubYear: m.pubYear,
      firstYear,
      total: m.total,
      counts,
      months: b.months,
      monthsComplete: opts.monthsComplete,
      capped: opts.capped ?? [],
      excluded: opts.counts ? Math.max(0, m.total - listed) : b.excluded,
      complete: opts.complete,
      fetchedAt: now.toISOString(),
    };
  };

  // Seen before: the website endpoint alone redraws the bars, without the rate-limited API.
  let yearly: Record<number, number> | null = null;
  if (meta) {
    yearly = await siteYearCounts(meta.paperId, firstYearOf(meta.pubYear), currentYear, say);
    if (yearly) emit(snapshot(meta, [], { complete: true, monthsComplete: false, counts: yearly }));
  }

  // One API request returns the paper and its newest 1000 citations, which is
  // everything for most papers.
  say('asking Semantic Scholar');
  let paper: S2Paper;
  try {
    paper = await s2<S2Paper>(
      `arXiv:${encodeURIComponent(id)}?fields=title,year,citationCount,citations.${CITE_FIELDS.replace(',', ',citations.')}`,
      key,
      say,
    );
  } catch (e) {
    // API overloaded but the bars are already up: keep them.
    if (meta && yearly) return snapshot(meta, [], { complete: true, monthsComplete: false, counts: yearly });
    throw e;
  }
  if (paper.paperId) {
    const fresh: PaperMeta = { paperId: paper.paperId, title: paper.title ?? '', pubYear: paper.year ?? null, total: paper.citationCount ?? 0 };
    if (!meta || meta.paperId !== fresh.paperId) yearly = null;
    meta = fresh;
    await chrome.storage.local.set({ [`meta:${id}`]: meta });
  }
  const m = { title: paper.title ?? '', pubYear: paper.year ?? null, total: paper.citationCount ?? 0 };
  const total = m.total;
  const firstYear = firstYearOf(m.pubYear);

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

  // Exact yearly counts from the website endpoint, used for the bars of every paper
  // so they match semanticscholar.org; the API's dates only shape months within years.
  yearly ??= paper.paperId ? await siteYearCounts(paper.paperId, firstYear, currentYear, say) : null;
  const counts = yearly ?? undefined;

  if (total <= PAGE || (paper.citations ?? []).length < PAGE) {
    return snapshot(m, rows(), { complete: true, monthsComplete: true, counts });
  }
  if (yearly) {
    if (total >= LIST_CAP) return snapshot(m, rows(), { complete: true, monthsComplete: false, counts });
    emit(snapshot(m, rows(), { complete: true, monthsComplete: false, counts }));
    await pageRest(id, total, key, say, add, () => {});
    return snapshot(m, rows(), { complete: true, monthsComplete: true, counts });
  }

  // Fallback: public API only.
  if (total < LIST_CAP) {
    emit(snapshot(m, rows(), { complete: false, monthsComplete: false }));
    await pageRest(id, total, key, say, add, () => emit(snapshot(m, rows(), { complete: false, monthsComplete: false })));
    return snapshot(m, rows(), { complete: true, monthsComplete: true });
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
      emit(snapshot(m, merged(), { complete: false, monthsComplete: false, capped: [...capped] }));
    });
  }
  await pool(tasks, key ? KEYED_CONCURRENCY : CONCURRENCY);
  const final = snapshot(m, merged(), { complete: true, monthsComplete: capped.length === 0, capped: capped.sort() });
  // Citations the per-year lists never return (no year) are the gap to the total.
  if (!capped.length) final.excluded = Math.max(final.excluded, total - merged().length);
  return final;
}

/** Pages citations 1000..total (the first 1000 came with the paper). */
async function pageRest(id: string, total: number, key: string, say: Say, add: (r: Row | undefined) => void, onPage: () => void) {
  const tasks: Array<() => Promise<void>> = [];
  for (let offset = PAGE; offset < Math.min(total + PAGE, LIST_CAP); offset += PAGE) {
    const limit = Math.min(PAGE, LIST_CAP - offset);
    tasks.push(async () => {
      const page = await s2<S2CitationPage>(citationsPath(id, offset, limit), key, say);
      (page.data ?? []).forEach((d) => add(d.citingPaper));
      onPage();
    });
  }
  await pool(tasks, key ? KEYED_CONCURRENCY : CONCURRENCY);
}

/** Exact per-year counts from the website endpoint, filtered to possible years; null on any failure. */
async function siteYearCounts(paperId: string, firstYear: number, currentYear: number, say: Say): Promise<Record<number, number> | null> {
  try {
    const site = await getJson<SitePaper>(SITE_API + encodeURIComponent(paperId), '', say);
    const buckets = site.paper?.citationStats?.citedByBuckets;
    if (!Array.isArray(buckets) || buckets.length === 0) return null;
    const counts: Record<number, number> = {};
    for (const b of buckets) {
      if (typeof b.startKey !== 'number' || b.startKey !== b.endKey || typeof b.count !== 'number') return null;
      if (b.startKey >= firstYear && b.startKey <= currentYear) counts[b.startKey] = b.count;
    }
    return counts;
  } catch {
    return null;
  }
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
