export type Trend = 'up' | 'flat' | 'down';

/** Per-year citation counts for one arXiv paper, as cached by the background worker. */
export interface CitationData {
  v: number;
  id: string;
  title: string;
  /** Semantic Scholar's year for the paper (can be a later venue year). */
  pubYear: number | null;
  /** Earliest year a citation can come from: the arXiv submission year or earlier S2 year. */
  firstYear: number;
  /** Semantic Scholar's headline citation count. */
  total: number;
  /** year -> citations published that year */
  counts: Record<number, number>;
  /** "YYYY-MM" -> citations with a publication date in that month */
  months: Record<string, number>;
  /** Years whose count hit the API's 10k list cap, so the true count is higher. */
  capped: number[];
  /** Citations with no year, or a year before submission or in the future. */
  excluded: number;
  /** False while pages are still arriving. */
  complete: boolean;
  fetchedAt: string;
}

export interface TrendResult {
  label: Trend | null;
  text: string;
  detail: string;
}

/** Smoothed monthly citation rate and its extrapolation to the end of the current year. */
export interface YearFit {
  /** Year and 0-based month of smooth[0]. */
  startYear: number;
  startMonth: number;
  /** Fitted citations per month, one per month up to the last complete month. */
  smooth: number[];
  /** Extrapolated citations per month for the rest of the current year. */
  future: number[];
  /** Expected citations for the whole current year. */
  projected: number;
}

/** Content script -> background. */
export interface CitationRequest {
  id: string;
}

/** Background -> content script. `data` can arrive several times: partial, cached, fresh. */
export type CitationReply =
  | { type: 'progress'; text: string }
  | { type: 'data'; data: CitationData }
  | { type: 'error'; message: string; notFound: boolean };

export const PORT_NAME = 'citations';
