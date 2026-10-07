# arXiv Citation Trends

A Chrome extension that adds a Google Scholar style **citations per year** chart to every arXiv abstract page, with a label saying whether the paper is **trending up**, **flat** or **trending down**.

![icon](static/icons/icon128.png)

## Install

```sh
npm install
npm run build
```

Then open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the `dist/` folder. Open any `arxiv.org/abs/...` page; the chart appears in the right column under "Access Paper".

Optional: add a free [Semantic Scholar API key](https://www.semanticscholar.org/product/api#api-key-form) in the extension's options. Anonymous requests share a rate limit, so the first load of a paper can take 30 to 60 seconds without one. Results are cached for 3 days.

## How the trend label works

- From July onwards, this year's citations so far are annualised and compared with last year.
- Before July, the last two full years are compared, because a few months of data are too noisy.
- **Trending up** needs at least +20% and at least 3 more citations a year. **Trending down** needs at least −20% and 3 fewer. Anything else is **flat**.
- Papers published this year say "new paper". Papers from last year say "too new" until July.
- Hover the label to see the numbers behind it, e.g. `2026 pace: 2169 vs 2025: 1253 (+73%)`.

The rule lives in `classifyTrend` in `src/core.ts`.

## Data

Counts come from the [Semantic Scholar Graph API](https://api.semanticscholar.org/api-docs/graph). Each citing paper is bucketed by its publication year. Citations with no year, or a year in the future, are reported as undated.

The citation list endpoint stops at 10,000 entries. Papers above that are counted one year at a time, and any single year over 10,000 is drawn hatched, and the trend label says "trend n/a" if it needs that year. Splitting capped years by month would work, since the filter accepts date ranges, but costs 200+ requests for the largest papers and misses citations that have a year but no date. OpenAlex was considered and rejected: it splits arXiv papers across several records and undercounts badly (26.8k vs 195.6k for "Attention Is All You Need").

Semantic Scholar indexes new citations with some delay, so the current year's pace can read slightly low.

## Develop

```sh
npm run check      # typecheck + unit tests + build
npm run watch      # rebuild dist/ on change, then reload the extension
```

| Path | Role |
| --- | --- |
| `src/core.ts` | arXiv id parsing, year bucketing, trend rule (pure, unit tested) |
| `src/background.ts` | service worker: Semantic Scholar fetching with backoff, cache |
| `src/chart.ts` | SVG bar chart |
| `src/content.ts` | widget on the abstract page |
| `src/options.ts` | API key and cache reset |
| `static/` | manifest, CSS, options page, icons |
| `art/` | icon sources (`icon.svg`, plus a simplified `icon16.svg`) |

Regenerate icons with `rsvg-convert`:

```sh
for s in 32 48 128; do rsvg-convert -w $s -h $s art/icon.svg -o static/icons/icon$s.png; done
rsvg-convert -w 16 -h 16 art/icon16.svg -o static/icons/icon16.png
```
