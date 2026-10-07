# Chrome Web Store listing

**Name:** Citation Trends

**Summary** (132 characters max):
Citations per year on arXiv abstract pages, with this year's projection and a trend label. Not affiliated with arXiv.

**Category:** Productivity

**Description:**

See where a paper is heading. Citation Trends adds a small chart to every arXiv abstract page, right under "Access Paper":

- Citations per year for the last five years
- The projected total for this year
- An S-curve fit of the citation rate
- A label: trending up, flat or trending down

Hover a bar for that year's count, or the label for the numbers behind it.

Citation data comes from Semantic Scholar. A free Semantic Scholar API key, added in the extension options, makes loading faster.

Citation Trends is an independent project. It is not affiliated with, reviewed by or endorsed by arXiv or Semantic Scholar.

**Single purpose:** show citation trends for the paper on an arXiv abstract page.

**Permission justifications:**
- storage: caches citation counts so charts load instantly, and keeps the optional API key.
- api.semanticscholar.org: source of citation data.
- www.semanticscholar.org/api: exact citations per year for a paper, in one request.

**Data usage:** no user data collected.

**Privacy policy:** https://github.com/squarerootminusone/arxiv-citation-trends/blob/main/PRIVACY.md
