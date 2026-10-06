import { Effect } from "effect";

// SteamRIP adds games daily, but `upgradeLocals` already refreshes at most
// once per 24h on connect. A catalog older than 6h is likely to miss a game
// added since, while a younger one is more likely a title mismatch that a
// scrape would not fix.
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

// A scrape opens a browser session and walks the whole catalog. Without a
// cooldown, a title that SteamRIP does not list would re-scrape on every
// search; 30 minutes bounds that to a few scrapes an hour at most.
export const COOLDOWN_MS = 30 * 60 * 1000;

type RefreshOnMissOptions = {
  getLastUpdated: () => number;
  // Expected to be single-flight, so overlapping calls share one scrape.
  refresh: () => Effect.Effect<void, unknown>;
  now?: () => number;
};

/**
 * Runs `find`; on a miss with a stale catalog and no recent attempt, refreshes
 * once and runs `find` again. A failed refresh keeps the original miss.
 */
export const createRefreshOnMiss = ({
  getLastUpdated,
  refresh,
  now = Date.now,
}: RefreshOnMissOptions) => {
  let lastAttemptAt = -Infinity;
  let running = 0;

  return <T>(find: () => T | undefined): Effect.Effect<T | undefined> =>
    Effect.gen(function* () {
      const first = find();
      if (first !== undefined) return first;

      const joining = running > 0;
      if (!joining) {
        const stale = now() - getLastUpdated() > STALE_AFTER_MS;
        const cooledDown = now() - lastAttemptAt >= COOLDOWN_MS;
        if (!stale || !cooledDown) return undefined;
        lastAttemptAt = now();
      }

      running++;
      yield* refresh().pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => console.error("Refresh on miss failed:", error)),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            running--;
            lastAttemptAt = now();
          }),
        ),
      );
      return find();
    });
};
