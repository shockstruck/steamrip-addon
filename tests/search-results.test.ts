import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  buildSearchResults,
  buildSteamripInfo,
  resolveSteamripInfo,
} from "../lib/search-results";

const game = { name: "Example Game", url: "https://example.invalid/example-game" };

describe("buildSearchResults", () => {
  it("returns the request result and the local result on a hit", () => {
    expect(
      buildSearchResults({ game, steamName: "Example Game", forType: "game" }),
    ).toEqual([
      { name: "Example Game", downloadType: "request", manifest: { url: game.url } },
      {
        name: "Example Game (install from downloaded archive)",
        downloadType: "empty",
        manifest: { url: game.url, source: "local" },
      },
    ]);
  });

  it("offers only the local result on a miss, named from Steam", () => {
    const results = buildSearchResults({
      game: undefined,
      steamName: "Gears of War: E-Day",
      forType: "game",
    });
    expect(results).toEqual([
      {
        name: "Gears of War: E-Day (install from downloaded archive)",
        downloadType: "empty",
        manifest: { source: "local" },
      },
    ]);
    expect("url" in results[0]!.manifest!).toBe(false);
  });

  it("offers no local result when updating, hit or miss", () => {
    const hit = buildSearchResults({ game, steamName: "Example Game", forType: "update" });
    expect(hit).toEqual([
      { name: "Example Game", downloadType: "request", manifest: { url: game.url } },
    ]);
    expect(
      buildSearchResults({ game: undefined, steamName: "Example Game", forType: "update" }),
    ).toEqual([]);
  });

  it("returns nothing for a task", () => {
    expect(buildSearchResults({ game, steamName: "x", forType: "task" })).toEqual([]);
    expect(
      buildSearchResults({ game: undefined, steamName: "x", forType: "task" }),
    ).toEqual([]);
  });
});

describe("buildSteamripInfo", () => {
  it("omits url and version when absent", () => {
    const info = buildSteamripInfo({ title: "Steam Name" });
    expect(info).toEqual({ title: "Steam Name" });
    expect(JSON.parse(JSON.stringify(info))).toEqual({ title: "Steam Name" });
  });

  it("keeps url and version when present", () => {
    expect(
      buildSteamripInfo({ title: "T", version: "v1", url: "https://example.invalid/g" }),
    ).toEqual({ title: "T", version: "v1", url: "https://example.invalid/g" });
  });
});

describe("resolveSteamripInfo", () => {
  it("does not scrape when there is no url", async () => {
    let calls = 0;
    const info = await Effect.runPromise(
      resolveSteamripInfo({
        url: undefined,
        steamName: "Steam Name",
        scrapeGameDetails: () => {
          calls += 1;
          return Effect.succeed({ title: "scraped", version: "v9" });
        },
      }),
    );
    expect(calls).toBe(0);
    expect(info).toEqual({ title: "Steam Name" });
  });

  it("scrapes when a url is present and falls back on failure", async () => {
    const ok = await Effect.runPromise(
      resolveSteamripInfo({
        url: "https://example.invalid/g",
        steamName: "Steam Name",
        scrapeGameDetails: () => Effect.succeed({ title: "scraped", version: "v9" }),
      }),
    );
    expect(ok).toEqual({ title: "scraped", version: "v9", url: "https://example.invalid/g" });

    const failed = await Effect.runPromise(
      resolveSteamripInfo({
        url: "https://example.invalid/g",
        steamName: "Steam Name",
        scrapeGameDetails: () => Effect.fail(new Error("boom")),
      }),
    );
    expect(failed).toEqual({ title: "unknown", url: "https://example.invalid/g" });
  });
});
