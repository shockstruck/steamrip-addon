import OGIAddon, { SearchTool, type SearchResult } from "ogi-addon";
import Scraper, { SCRAPE_PRIORITY } from "./lib/scraper";
import puppeteer from "puppeteer-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import adblock from "puppeteer-extra-plugin-adblocker";
import { detectServiceFromUrl, getService, getServiceNameFromUrl } from "./lib/services/matcher";
import FileCryptService from "./lib/services/FileCrypt";
import { Context, Effect, Layer, pipe } from "effect";
import { InvalidUrlError, NoGameFoundError, NoServiceFoundError, ScrapeGameDownloadsError, SteamSearchError } from "./lib/errors";

const baseAddon = new OGIAddon({
  name: 'steamrip-addon',
  version: '1.0.0',
  id: 'steamrip-addon',

  author: 'fat-addons',
  description: 'an addon to scrape steamrip and give you links.',
  repository: 'https://github.com/fat-addons/steamrip-addon'
});

class AddonService extends Context.Tag('AddonService')<AddonService, {
  addon: OGIAddon,
  stringSimilarity: (a: string, b: string) => number
}>() {}

const addonService = Layer.succeed(AddonService, {
  addon: baseAddon,
  stringSimilarity: (a: string, b: string): number => {
    a = a.toLowerCase();
    b = b.toLowerCase();

    // Return early for trivial equality
    if (a === b) return 1;

    // Create bigrams for each string
    const bigrams = (str: string): string[] => {
      const s = str.replace(/[^a-z0-9]+/g, ' '); // keep alphanumerics, replace others with space
      const pairs: string[] = [];
      for (let i = 0; i < s.length - 1; i++) {
        pairs.push(s.substring(i, i + 2));
      }
      return pairs;
    };

    const pairsA = bigrams(a);
    const pairsB = bigrams(b);

    if (pairsA.length === 0 || pairsB.length === 0) return 0;

    let intersection = 0;
    const pairsBMutable = [...pairsB];
    for (const pair of pairsA) {
      const idx = pairsBMutable.indexOf(pair);
      if (idx !== -1) {
        intersection++;
        pairsBMutable.splice(idx, 1); // remove to prevent double counting
      }
    }

    return (2 * intersection) / (pairsA.length + pairsB.length);
  }
});

Effect.runSync(Effect.gen(function* () {
  puppeteer.use(stealth());
  puppeteer.use(adblock());

  const scraper = new Scraper();
  const search = new SearchTool<{ name: string, url: string }>([], ['name']);

  const { addon, stringSimilarity } = yield* AddonService;
  
  addon.on('configure', (config) => config)

  addon.on('connect', () => {
    const connectEffect = Effect.gen(function*() {
      const task = yield* Effect.tryPromise({
        try: () => addon.task(),
        catch: () => new Error('Failed to create task') // Define a specific error if needed
      });
      yield* Effect.sync(() => task.log('Implementing local catalog...'));
      yield* scraper.upgradeLocals();

      yield* Effect.sync(() => task.log('Processing local catalog...'));

      yield* scraper.processLocals();
      search.addItems(scraper.catalog.games);
      yield* Effect.sync(() => task.finish());
    });

    Effect.runPromise(connectEffect).catch(error => {
      console.error("Error during connect:", error);
    });
  });

  addon.on('search', (query, event) => {
    if (query.type !== 'steamapp') {
      event.resolve([]);
      return;
    }
    event.defer();
    
    const searchEffect = Effect.gen(function* () {
      const steamResults = yield* Effect.tryPromise({
        try: async () => await addon.steamSearch(query.text, true),
        catch: () => new SteamSearchError({ query: query.text })
      });

      if (steamResults.length === 0) {
        return yield* Effect.fail(new SteamSearchError({ query: query.text }));
      }
      
      const steamResult = steamResults[0];
      // Find the game with the highest name similarity to the Steam result
      let bestMatch: { name: string; url: string } | undefined;
      let bestScore = 0;
      for (const candidate of scraper.catalog.games) {
        const score = stringSimilarity(candidate.name, steamResult.name);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = candidate;
        }
      }

      // Require a minimum similarity to consider it a valid match
      const SIMILARITY_THRESHOLD = 0.3;
      console.log("Best score", bestScore);
      const game = bestScore >= SIMILARITY_THRESHOLD ? bestMatch : undefined;

      if (!game) {
        console.log("No game found");
        return yield* Effect.fail(new NoGameFoundError({ query: query.text }));
      }
      
      console.log("Found game", game.name);
      const resolutions = [{
        name: game.name,
        downloadType: 'request',
        storefront: 'steam'
      }] as SearchResult[];

      return resolutions;
    });

    pipe(
      searchEffect,
      Effect.catchTags({
        NoGameFoundError: (e: NoGameFoundError) => {
          console.log("No game found", e);
          return Effect.succeed([]);
        },
        SteamSearchError: (e: SteamSearchError) => {
          console.log("Steam search error", e);
          return Effect.succeed([]);
        }
      }),
      Effect.runPromise
    ).then(result => {
      event.resolve(result);
    }).catch(error => {
      console.error("Unexpected error in search:", error);
      event.resolve([]);
    });
  });

  addon.on('request-dl', (appid, info, event) => {
    event.defer();

    const getDownloadLinks = Effect.try({
      try: () => {
        const game = scraper.catalog.games.find(g => g.name === info.name);
        if (!game) throw new NoGameFoundError({ query: info.name });
        return scraper.scrapeGameDownloads(game.url);
      },
      catch: (e) => e instanceof NoGameFoundError ? e : new ScrapeGameDownloadsError({ game: info.name })
    });

    const findWorkingService = (links: { service: string; url: string }[]) => Effect.gen(function*() {
      const services = links
        .map(link => {
          const serviceName = getServiceNameFromUrl(link.url);
          const priority = serviceName === 'FileCrypt' ? 8 : serviceName === 'Buzzheavier' ? 6 : serviceName === 'Gofile' ? 5 : serviceName === 'Fichier' ? 4 : 0;
          return { name: serviceName, url: link.url, priority };
        })
        .filter((s): s is { name: string; url: string; priority: number } => !!s.name)
        .sort((a, b) => b.priority - a.priority);

      return yield* Effect.forEach(services, serviceInfo =>
        Effect.gen(function*() {
          console.log(`Trying service: ${serviceInfo.name}`);
          let service = yield* getService(serviceInfo.name);
          let currentUrl = serviceInfo.url;

          if (service instanceof FileCryptService) {
            const fcResult = yield* service.scrapeDownloadLinks(currentUrl);
            if (fcResult.length === 0 || !fcResult[0].url) {
              return yield* Effect.fail(new Error("FileCrypt did not return a URL"));
            }
            const nextServiceName = getServiceNameFromUrl(fcResult[0].url);
            if (!nextServiceName) {
              return yield* Effect.fail(new Error(`No service found for ${fcResult[0].url}`));
            }
            service = yield* getService(nextServiceName);
            currentUrl = fcResult[0].url;
          }

          const downloadUrls = yield* service.scrapeDownloadLinks(currentUrl);
          if (downloadUrls.length > 0 && downloadUrls[0].url) {
            return { url: downloadUrls[0].url, name: downloadUrls[0].name };
          }
          return yield* Effect.fail(new Error(`${service.name} returned no valid URLs`));
        }),
        { concurrency: 1 }
      ).pipe(
        Effect.flatMap(results => {
          // Find the first successful result (not an error)
          const firstSuccess = results.find(r => !(r instanceof Error));
          if (firstSuccess) {
            return Effect.succeed(firstSuccess);
          }
          // If all failed, return the first error
          const firstError = results.find(r => r instanceof Error);
          return Effect.fail(firstError ?? new Error("No valid download links found"));
        }),
      );
    });

    const requestDlEffect = Effect.gen(function*() {
      const links = yield* getDownloadLinks;
      const downloadDetails = yield* findWorkingService(yield* links);

      return {
        downloadType: 'direct',
        name: info.name,
        storefront: 'steam',
        files: [{ name: downloadDetails.name, downloadURL: downloadDetails.url }]
      } as SearchResult;
    });

    pipe(
      requestDlEffect,
      Effect.match({
        onFailure: (error) => {
          console.error("Failed to get download link:", error);
          event.fail('Failed to get download link');
        },
        onSuccess: (result) => {
          console.log("Success:", result);
          event.resolve(result);
        }
      }),
      Effect.runPromise
    );
  });

  addon.on('disconnect', () => {
    process.exit(0);
  }); 

}).pipe(Effect.provide(addonService)))