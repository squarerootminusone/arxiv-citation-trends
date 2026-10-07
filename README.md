# arXiv Citation Trends

A Chrome extension that adds a citations-per-year chart to every arXiv abstract page. It shows a fitted citation-rate curve, a projected total for the current year, and a label saying whether the paper is **trending up**, **flat** or **trending down**.

![icon](static/icons/icon128.png)

## Install

```sh
npm install
npm run build
```

Then open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the `dist/` folder. Open any `arxiv.org/abs/...` page; the chart appears in the right column under "Access Paper".

## What the chart shows

- Blue bars are citations per year for the last five years, zero where there were none.
- The lighter blue cap on the current year is the expected rest of the year.
- The orange curve is an S-curve fit of the monthly citation rate, annualised so it reads on the same axis as the bars. Its dashed tail is the extrapolation to December.
- The trend label sits in whichever top corner of the chart has room; hover it for the numbers behind it.
- Hovering a bar shows that year's count in the heading.
- While loading, the same frame shows a spinner.

## Projection and trend label

Monthly counts come from each citing paper's publication date. Each year's months are scaled up so they add to that year's full count, because a few citations have a year but no date. The current, partial month is left out.

The curve is a four-parameter logistic, rate(t) = b + K·sigmoid(k·(t − t0)), fitted by weighted least squares. For a fixed steepness and midpoint the model is linear in b and K, so those are solved exactly while k and t0 are searched on a grid. Weights treat counts as Poisson-like and favour recent months (two-year half-life). A falling S (K < 0) fits declining papers. Because an S-curve levels off, the extrapolation cannot run away. The projection is the actual count through last month plus the fitted rate for the remaining months.

The label compares the projected total with last year. **Trending up** needs at least +20% and 3 more citations a year; **trending down** needs at least −20% and 3 fewer; anything else is **flat**. Papers with too little data fall back to this year's pace, or to the last two full years before July. Papers published this year say "new paper".

The model lives in `fitSCurve`, `fitYear` and `classifyTrend` in `src/core.ts`. A backtest on the Fourier Neural Operator paper projected 1,215 for 2025 from October 2025; the actual count was 1,253.

## Data and speed

Counts come from the [Semantic Scholar Graph API](https://api.semanticscholar.org/api-docs/graph). Citations dated before the paper's arXiv submission year are index errors and are dropped, as are undated ones.

- One request returns the paper and its newest 1,000 citations, which covers most papers.
- Larger papers page through the rest, three pages at a time, and the chart fills in as pages arrive.
- Refused requests (429, 5xx) get exponential backoff with jitter (1 s doubling to 32 s), honour Retry-After, and pause all parallel requests together.
- With an API key, requests go one at a time, at least 1.1 s apart, inside the 1 request per second limit.
- Results are cached. Anything under a day old is shown without a request; older data is shown at once and refreshed in the background.
- A free [Semantic Scholar API key](https://www.semanticscholar.org/product/api#api-key-form) in the options avoids the shared pool.

The citation list stops at 10,000 entries. Papers above that are counted one year at a time, and a year over 10,000 is drawn hatched with no projection. Splitting such years by month would work, since the filter accepts date ranges, but costs 200+ requests and misses citations that have a year but no date. OpenAlex was considered and rejected: it splits arXiv papers across several records and undercounts badly (26.8k vs 195.6k for "Attention Is All You Need").

## Develop

```sh
npm run check      # typecheck + unit tests + build
npm run watch      # rebuild dist/ on change, then reload the extension
```

| Path | Role |
| --- | --- |
| `src/core.ts` | arXiv id parsing, bucketing, curve fit, projection, trend rule (pure, unit tested) |
| `src/background.ts` | service worker: Semantic Scholar fetching, retries, cache |
| `src/chart.ts` | SVG frame, bars, curve, projected cap, trend label placement |
| `src/content.ts` | widget on the abstract page |
| `src/options.ts` | API key and cache reset |
| `static/` | manifest, CSS, options page, icons |
| `art/` | icon sources (`icon.svg`, plus a simplified `icon16.svg`) |

Regenerate icons with `rsvg-convert`:

```sh
for s in 32 48 128; do rsvg-convert -w $s -h $s art/icon.svg -o static/icons/icon$s.png; done
rsvg-convert -w 16 -h 16 art/icon16.svg -o static/icons/icon16.png
```

`art/icon16.svg` is a simplified drawing for the toolbar size.
