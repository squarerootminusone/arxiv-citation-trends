export type Trend = 'up' | 'flat' | 'down';

/** Per-year citation counts for one arXiv paper, as cached by the background worker. */
export interface CitationData {
  v: number;
  id: string;
  title: string;
  pubYear: number | null;
  /** Semantic Scholar's headline citation count. */
  total: number;
  /** year -> citations published that year */
  counts: Record<number, number>;
  /** Years whose count hit the API's 10k list cap, so the true count is higher. */
  capped: number[];
  /** Citations without a usable year; null when unknown because a year was capped. */
  undated: number | null;
  fetchedAt: string;
  s2Url: string | null;
}

export interface TrendResult {
  label: Trend | null;
  text: string;
  detail: string;
}

/** Content script -> background. */
export interface CitationRequest {
  id: string;
  force?: boolean;
}

/** Background -> content script. */
export type CitationReply =
  | { type: 'progress'; text: string }
  | { type: 'done'; data: CitationData; cached: boolean }
  | { type: 'error'; message: string; notFound: boolean };

export const PORT_NAME = 'citations';
