import { Effect } from "effect";

export type CatalogGame = { name: string; url: string };

export type LocalSearchResult = {
  name: string;
  downloadType: "request" | "empty";
  manifest?: { url?: string; source?: "local" };
};

export type SteamripInfo = { title: string; version?: string; url?: string };

/**
 * Builds the search results for one Steam game. The local-archive option does
 * not need a catalog match (the user supplies the archive), so it is offered
 * on a miss too; an update never offers it, and a miss on an update has
 * nothing to compare against.
 */
export function buildSearchResults({
  game,
  steamName,
  forType,
}: {
  game: CatalogGame | undefined;
  steamName: string;
  forType: string | undefined;
}): LocalSearchResult[] {
  if (forType === "task") return [];
  const results: LocalSearchResult[] = [];
  if (game) {
    results.push({
      name: game.name,
      downloadType: "request",
      manifest: { url: game.url },
    });
  }
  if (forType !== "update") {
    results.push({
      name: `${game ? game.name : steamName} (install from downloaded archive)`,
      downloadType: "empty",
      manifest: game ? { url: game.url, source: "local" } : { source: "local" },
    });
  }
  return results;
}

/** `steamrip-info.json` content; absent `url`/`version` are left out. */
export function buildSteamripInfo(fields: {
  title: string;
  version?: string;
  url?: string;
}): SteamripInfo {
  const info: SteamripInfo = { title: fields.title };
  if (fields.version !== undefined) info.version = fields.version;
  if (fields.url !== undefined) info.url = fields.url;
  return info;
}

/**
 * Resolves the info to write after setup. Only a manifest `url` is scraped;
 * without one (a local archive with no catalog match) the Steam name is used
 * and the scraper is never called.
 */
export function resolveSteamripInfo<E>({
  url,
  steamName,
  scrapeGameDetails,
}: {
  url: string | undefined;
  steamName: string | undefined;
  scrapeGameDetails: (
    url: string,
  ) => Effect.Effect<{ title?: string; version?: string }, E>;
}): Effect.Effect<SteamripInfo> {
  if (url === undefined) {
    return Effect.succeed(
      buildSteamripInfo({ title: steamName ?? "unknown" }),
    );
  }
  return scrapeGameDetails(url).pipe(
    Effect.catchAll((error) => {
      console.error("Failed to get app details", url, error);
      return Effect.succeed({ title: undefined, version: undefined });
    }),
    Effect.map((details) =>
      buildSteamripInfo({
        title: details.title ?? "unknown",
        version: details.version,
        url,
      }),
    ),
  );
}
