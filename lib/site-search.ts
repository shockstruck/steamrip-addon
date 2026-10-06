import { JSDOM } from "jsdom";
import { Effect } from "effect";

export type SiteSearchResult = { name: string; url: string };

const SITE = "https://steamrip.com/";

// Selectors are tried in order and the first one that yields a post wins. The
// masonry grid is what the site search renders; the others cover a theme change.
const RESULT_SELECTORS = [
  "#masonry-grid .thumb-title a",
  "article h2 a",
  "h2 a",
];

export const siteSearchUrl = (name: string): string =>
  `${SITE}?s=${encodeURIComponent(name)}`;

export function parseSiteSearch(html: string): SiteSearchResult[] {
  const document = new JSDOM(html).window.document;

  for (const selector of RESULT_SELECTORS) {
    const seen = new Set<string>();
    const results: SiteSearchResult[] = [];
    for (const link of Array.from(document.querySelectorAll(selector))) {
      const name = link.textContent?.replace(/\s+/g, " ").trim();
      const href = link.getAttribute("href")?.trim();
      if (!name || !href) continue;
      let url: string;
      try {
        url = new URL(href, SITE).toString();
      } catch {
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({ name, url });
    }
    if (results.length > 0) return results;
  }
  return [];
}

export type SiteSearchOutcome = {
  match: SiteSearchResult | undefined;
  count: number;
  best: SiteSearchResult | undefined;
  score: number;
};

// A failed fetch is a miss, not an error: the search handler must still answer.
export const findViaSiteSearch = ({
  name,
  fetchHtml,
  similarity,
  threshold = 0.6,
}: {
  name: string;
  fetchHtml: (url: string) => Effect.Effect<string, unknown>;
  similarity: (a: string, b: string) => number;
  threshold?: number;
}): Effect.Effect<SiteSearchOutcome> =>
  fetchHtml(siteSearchUrl(name)).pipe(
    Effect.map(parseSiteSearch),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error(`SteamRIP site-search fetch failed for "${name}":`, error);
        return [] as SiteSearchResult[];
      }),
    ),
    Effect.map((results) => {
      let best: SiteSearchResult | undefined;
      let score = 0;
      for (const result of results) {
        const s = similarity(result.name, name);
        if (s > score) {
          score = s;
          best = result;
        }
      }
      return {
        match: score >= threshold ? best : undefined,
        count: results.length,
        best,
        score,
      };
    }),
  );
