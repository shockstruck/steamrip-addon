import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  COOLDOWN_MS,
  STALE_AFTER_MS,
  createRefreshOnMiss,
} from "../lib/refresh-on-miss";
import { singleFlight } from "../lib/single-flight";

type Game = { name: string; url: string };

// Synthetic catalog; hosts are example.invalid and nothing touches the network.
const OLD: Game[] = [{ name: "Old Game Free Download", url: "https://example.invalid/old" }];
const NEW: Game[] = [
  ...OLD,
  { name: "Brand New Game Free Download", url: "https://example.invalid/new" },
];

const setup = (lastUpdated: number, now = { value: 1_000_000_000 }) => {
  const catalog = { games: OLD, lastUpdated };
  let refreshes = 0;
  const refresh = singleFlight(() =>
    Effect.promise(async () => {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      catalog.games = NEW;
      catalog.lastUpdated = now.value;
    }),
  );
  const find = (title: string) => () =>
    catalog.games.find((game) => game.name.startsWith(title));
  const refreshOnMiss = createRefreshOnMiss({
    getLastUpdated: () => catalog.lastUpdated,
    refresh,
    now: () => now.value,
  });
  return { catalog, now, find, refreshOnMiss, refreshes: () => refreshes };
};

describe("refreshOnMiss", () => {
  it("refreshes a stale catalog once on a miss and then matches", async () => {
    const t = setup(1_000_000_000 - STALE_AFTER_MS - 1);
    const game = await Effect.runPromise(
      t.refreshOnMiss(t.find("Brand New Game")),
    );
    expect(game?.url).toBe("https://example.invalid/new");
    expect(t.refreshes()).toBe(1);
  });

  it("does not refresh a fresh catalog", async () => {
    const t = setup(1_000_000_000 - 1000);
    const game = await Effect.runPromise(
      t.refreshOnMiss(t.find("Brand New Game")),
    );
    expect(game).toBeUndefined();
    expect(t.refreshes()).toBe(0);
  });

  it("does not return a hit through a refresh", async () => {
    const t = setup(1_000_000_000 - STALE_AFTER_MS - 1);
    await Effect.runPromise(t.refreshOnMiss(t.find("Old Game")));
    expect(t.refreshes()).toBe(0);
  });

  it("does not re-scrape for a second miss inside the cooldown", async () => {
    const t = setup(1_000_000_000 - STALE_AFTER_MS - 1);
    let calls = 0;
    const counted = createRefreshOnMiss({
      getLastUpdated: () => t.catalog.lastUpdated,
      refresh: () => Effect.sync(() => void calls++),
      now: () => t.now.value,
    });
    // The stubbed scrape finds nothing new, so lastUpdated stays stale.
    await Effect.runPromise(counted(() => undefined));
    t.now.value += COOLDOWN_MS - 1;
    await Effect.runPromise(counted(() => undefined));
    expect(calls).toBe(1);
    t.now.value += 2;
    await Effect.runPromise(counted(() => undefined));
    expect(calls).toBe(2);
  });

  it("shares one refresh between concurrent misses", async () => {
    const t = setup(1_000_000_000 - STALE_AFTER_MS - 1);
    const [a, b] = await Effect.runPromise(
      Effect.all(
        [
          t.refreshOnMiss(t.find("Brand New Game")),
          t.refreshOnMiss(t.find("Brand New Game")),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(a?.url).toBe("https://example.invalid/new");
    expect(b?.url).toBe("https://example.invalid/new");
    expect(t.refreshes()).toBe(1);
  });

  it("keeps the miss when the refresh fails", async () => {
    const t = setup(1_000_000_000 - STALE_AFTER_MS - 1);
    const failing = createRefreshOnMiss({
      getLastUpdated: () => t.catalog.lastUpdated,
      refresh: () => Effect.fail(new Error("scrape failed")),
      now: () => t.now.value,
    });
    expect(await Effect.runPromise(failing(t.find("Brand New Game")))).toBeUndefined();
  });
});
