# Privacy

Citation Trends collects no personal data and has no server of its own.

**What it reads.** On arXiv abstract pages (`arxiv.org/abs/...`) it reads the paper id from the page address. It reads nothing else from any page, and it does not run on other sites.

**What it sends.** To look up citations it sends the paper id, and Semantic Scholar's id for that paper, to Semantic Scholar (`api.semanticscholar.org` and `www.semanticscholar.org`). If you add a Semantic Scholar API key in the options, the key is sent with those requests. Nothing is sent anywhere else, and there is no analytics or tracking.

**What it stores, in your browser only.**

- Citation counts and Semantic Scholar ids for papers you have opened, so charts load instantly next time. "Clear cached citations" in the options removes the counts.
- Your Semantic Scholar API key, if you add one. It is kept in Chrome's synced extension storage, so it follows your Chrome profile if you use Chrome sync.

Semantic Scholar's handling of the requests is covered by its own policies at [semanticscholar.org](https://www.semanticscholar.org).

Questions: open an issue at https://github.com/squarerootminusone/arxiv-citation-trends/issues.
