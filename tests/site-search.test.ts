import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  findViaSiteSearch,
  parseSiteSearch,
  siteSearchUrl,
} from "../lib/site-search";
import { stringSimilarity } from "../lib/services/matcher";
import Scraper from "../lib/scraper";

// Synthetic markup and example.invalid hosts only; nothing touches the network.
const MASONRY = `
<div id="masonry-grid">
  <div class="thumb"><a href="https://example.invalid/gears-of-war-e-day-free-download/"></a>
    <div class="thumb-title"><a href="https://example.invalid/gears-of-war-e-day-free-download/">Gears of War: E-Day Free Download</a></div>
  </div>
  <div class="thumb">
    <div class="thumb-title"><a href="/gears-of-war-free-download/"> Gears of War Free Download (v1.3) </a></div>
  </div>
</div>`;

const ARTICLE = `
<main>
  <article><h2 class="entry-title"><a href="https://example.invalid/a/">Game A Free Download</a></h2></article>
  <article><h2><a href="https://example.invalid/b/">Game B Free Download</a></h2></article>
</main>`;

const BARE_H2 = `
<section>
  <h2><a href="https://example.invalid/c/">Game C Free Download</a></h2>
  <h2><a href="https://example.invalid/c/">Game C Free Download</a></h2>
  <h2><a href="">No Link</a></h2>
  <h2><a href="https://example.invalid/d/">   </a></h2>
</section>`;

describe("parseSiteSearch", () => {
  it("reads #masonry-grid .thumb-title a and resolves relative links", () => {
    expect(parseSiteSearch(MASONRY)).toEqual([
      {
        name: "Gears of War: E-Day Free Download",
        url: "https://example.invalid/gears-of-war-e-day-free-download/",
      },
      {
        name: "Gears of War Free Download (v1.3)",
        url: "https://steamrip.com/gears-of-war-free-download/",
      },
    ]);
  });

  it("falls back to article h2 a", () => {
    expect(parseSiteSearch(ARTICLE).map((r) => r.name)).toEqual([
      "Game A Free Download",
      "Game B Free Download",
    ]);
  });

  it("falls back to bare h2 a, dropping duplicates and empty entries", () => {
    expect(parseSiteSearch(BARE_H2)).toEqual([
      { name: "Game C Free Download", url: "https://example.invalid/c/" },
    ]);
  });

  it("returns nothing for a page without results", () => {
    expect(parseSiteSearch("<html><body><p>Nothing found</p></body></html>")).toEqual([]);
  });
});

describe("findViaSiteSearch", () => {
  const run = (name: string, html: string | Error) => {
    const urls: string[] = [];
    const result = Effect.runSync(
      findViaSiteSearch({
        name,
        similarity: stringSimilarity,
        fetchHtml: (url) => {
          urls.push(url);
          return html instanceof Error ? Effect.fail(html) : Effect.succeed(html);
        },
      }),
    );
    return { result, urls };
  };

  it("builds an encoded WordPress search URL", () => {
    expect(siteSearchUrl("Gears of War: E-Day")).toBe(
      "https://steamrip.com/?s=Gears%20of%20War%3A%20E-Day",
    );
  });

  it("finds Gears of War: E-Day on a site-search page", () => {
    const { result, urls } = run("Gears of War: E-Day", MASONRY);
    expect(urls).toEqual([siteSearchUrl("Gears of War: E-Day")]);
    expect(result.count).toBe(2);
    expect(result.match).toEqual({
      name: "Gears of War: E-Day Free Download",
      url: "https://example.invalid/gears-of-war-e-day-free-download/",
    });
    expect(result.score).toBe(1);
  });

  it("still rejects the original Gears of War at 0.55", () => {
    const html = `<div id="masonry-grid"><div class="thumb-title"><a href="https://example.invalid/g/">Gears of War Free Download (v1.3)</a></div></div>`;
    const { result } = run("Gears of War: E-Day", html);
    expect(result.match).toBeUndefined();
    expect(result.best?.name).toBe("Gears of War Free Download (v1.3)");
    expect(result.score).toBeCloseTo(0.55, 2);
  });

  it("treats a failed fetch as a miss instead of failing the search", () => {
    const { result } = run("Gears of War: E-Day", new Error("blocked"));
    expect(result).toEqual({ match: undefined, count: 0, best: undefined, score: 0 });
  });
});

describe("Scraper.addGame", () => {
  it("adds a game to the in-memory catalog once, without touching disk", () => {
    const scraper = new Scraper({
      catalogPath: "/nonexistent.invalid/catalog.json",
      scrapesDir: "/nonexistent.invalid/scrapes",
    });
    const game = { name: "New Game Free Download", url: "https://example.invalid/n/" };
    scraper.addGame(game);
    scraper.addGame({ ...game });
    expect(scraper.catalog.games).toEqual([game]);
  });
});
