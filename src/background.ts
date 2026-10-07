// Fetches citation years from Semantic Scholar and caches per-year counts.
// Runs in the service worker because host permissions bypass CORS there: the API's
// 429 replies carry no CORS header, so a page-side fetch could never see them to back off.
import { LIST_CAP, bucketYears } from './core.ts';
import { PORT_NAME, type CitationData, type CitationReply, type CitationRequest } from './types.ts';

const API = 'https://api.semanticscholar.org/graph/v1/paper/';
const CACHE_TTL_MS = 3 * 24 * 3600 * 1000;
const CACHE_VERSION = 1;
const MAX_ATTEMPTS = 8;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

type Say = (text: string) => void;

interface S2Paper {
  paperId?: string;
  title?: string;
  year?: number | null;
  citationCount?: number | null;
}
interface S2CitationPage {
  next?: number;
  data?: Array<{ citingPaper?: { year?: number | null } }>;
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

/** GET with retry on 429/5xx. `say` reports progress, which also keeps the port and worker alive. */
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
    const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
    const why = res?.status === 429 ? 'rate limited' : 'server busy';
    for (let left = wait; left > 0; left -= 2000) {
      say(`${why}, retrying in ${Math.ceil(left / 1000)} s`);
      await sleep(Math.min(2000, left));
    }
  }
  throw new Error(
    key ? 'Semantic Scholar kept refusing requests' : 'Rate limited by Semantic Scholar. A free API key in the extension options helps.',
  );
}

/** Pages the citation list, which comes newest first. */
async function listCitationYears(
  id: string,
  yearFilter: number | null,
  key: string,
  say: Say,
  label: string,
): Promise<{ years: Array<number | null>; capped: boolean }> {
  const years: Array<number | null> = [];
  const filter = yearFilter === null ? '' : `&publicationDateOrYear=${yearFilter}`;
  const path = `arXiv:${encodeURIComponent(id)}/citations?fields=year`;
  if (yearFilter !== null) {
    // One cheap probe at the last listable slot: if it exists, this year is over the
    // cap and paging through 10 full pages would only confirm that.
    say(`${label}: checking size`);
    const probe = await s2<S2CitationPage>(`${path}&limit=1&offset=${LIST_CAP - 1}${filter}`, key, say);
    if ((probe.data ?? []).length > 0) return { years: new Array<number | null>(LIST_CAP).fill(yearFilter), capped: true };
  }
  let offset = 0;
  for (;;) {
    const limit = Math.min(1000, LIST_CAP - offset);
    if (limit <= 0) return { years, capped: true };
    say(`${label}: ${years.length.toLocaleString()} citations so far`);
    const page = await s2<S2CitationPage>(`${path}&limit=${limit}&offset=${offset}${filter}`, key, say);
    const data = page.data ?? [];
    for (const d of data) years.push(d.citingPaper?.year ?? null);
    if (page.next == null || data.length === 0) return { years, capped: false };
    offset = page.next;
  }
}

async function compute(id: string, say: Say): Promise<CitationData> {
  const key = await apiKey();
  say('looking up paper');
  const paper = await s2<S2Paper>(`arXiv:${encodeURIComponent(id)}?fields=title,year,citationCount`, key, say);
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const total = paper.citationCount ?? 0;
  const pubYear = paper.year ?? null;
  let counts: Record<number, number> = {};
  let undated: number | null = 0;
  const capped: number[] = [];

  if (total < LIST_CAP) {
    const { years } = await listCitationYears(id, null, key, say, 'reading');
    ({ counts, undated } = bucketYears(years, currentYear));
  } else {
    // Too many for one list: count each year on its own, newest first.
    const first = Math.min(pubYear ?? currentYear, currentYear);
    let listed = 0;
    for (let yr = currentYear; yr >= first; yr--) {
      const { years, capped: hit } = await listCitationYears(id, yr, key, say, String(yr));
      counts[yr] = years.length;
      listed += years.length;
      if (hit) capped.push(yr);
    }
    undated = capped.length ? null : Math.max(0, total - listed);
  }

  return {
    v: CACHE_VERSION,
    id,
    title: paper.title ?? '',
    pubYear,
    total,
    counts,
    capped,
    undated,
    fetchedAt: now.toISOString(),
    s2Url: paper.paperId ? `https://www.semanticscholar.org/paper/${paper.paperId}` : null,
  };
}

async function fromCache(id: string): Promise<CitationData | null> {
  const k = `cit:${id}`;
  const got = await chrome.storage.local.get(k);
  const hit = got[k] as CitationData | undefined;
  if (hit && hit.v === CACHE_VERSION && Date.now() - Date.parse(hit.fetchedAt) < CACHE_TTL_MS) return hit;
  return null;
}

/** One fetch per paper even when several tabs ask at once. */
const inflight = new Map<string, { job: Promise<CitationData>; listeners: Set<Say> }>();

function startJob(id: string) {
  let entry = inflight.get(id);
  if (!entry) {
    const listeners = new Set<Say>();
    const job = compute(id, (text) => listeners.forEach((f) => f(text)))
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

  port.onMessage.addListener(async ({ id, force }: CitationRequest) => {
    try {
      if (!force) {
        const hit = await fromCache(id);
        if (hit) return post({ type: 'done', data: hit, cached: true });
      }
      const { job, listeners } = startJob(id);
      const say: Say = (text) => post({ type: 'progress', text });
      listeners.add(say);
      try {
        post({ type: 'done', data: await job, cached: false });
      } finally {
        listeners.delete(say);
      }
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e), notFound: e instanceof NotFound });
    }
  });
});
