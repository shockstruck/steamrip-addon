import OGIAddon, { ConfigurationBuilder, SearchTool, type SearchResult } from "ogi-addon";
import Scraper from "./lib/scraper";
import puppeteer from "puppeteer-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import adblock from "puppeteer-extra-plugin-adblocker";
import { getService, getServiceNameFromUrl } from "./lib/services/matcher";
import FileCryptService from "./lib/services/FileCrypt";
import { Context, Effect, Layer, Match, pipe } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import { CommonRedistError, FileCryptError, InputError, NoDownloadFoundError, NoFileFoundError, NoGameFoundError, NoServiceFoundError, RarExtractionError, ScrapeGameDownloadsError, SteamSearchError } from "./lib/errors";
import { join } from "path";
import { spawnSync } from "child_process";
import * as fs from 'fs/promises';
import type { Stats } from "fs";

const baseAddon = new OGIAddon({
  name: 'Steamrip Tool',
  version: '1.0.0',
  id: 'steamrip-addon',
  author: 'fat-addons',
  description: 'An addon to scrape steamrip and provide direct download links.',
  repository: 'https://gitlab.com/fat-addons/steamrip-addon',
  storefronts: [ 'steam' ]

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

const program = Effect.gen(function* () {
  puppeteer.use(stealth());
  puppeteer.use(adblock());

  const scraper = new Scraper();
  const search = new SearchTool<{ name: string, url: string }>([], ['name']);

  const { addon, stringSimilarity } = yield* AddonService;
  
  addon.on('configure', (config) => config
    .addBooleanOption(option => option
      .setName('disallowCaptchaBased')
      .setDisplayName('Disallow Captcha Based Services')
      .setDescription('Disallow services that require a captcha to be solved.')
      .setDefaultValue(false)
    )
  )

  addon.on('connect', () => {
    const connectEffect = Effect.fn('connectEffect')(function*() {
      const task = yield* Effect.tryPromise({
        try: () => addon.task(),
        catch: () => new Error('Failed to create task') // Define a specific error if needed
      });

      yield* Effect.sync(() => task.log('Implementing local catalog...'));
      yield* scraper.upgradeLocals();
      yield* Effect.sync(() => task.log('Processing local catalog...'));
      yield* scraper.processLocals();
      yield* Effect.sync(() => search.addItems(scraper.catalog.games));
      yield* Effect.sync(() => task.finish());
    });

    Effect.runPromise(connectEffect()).catch(error => {
      console.error("Error during connect:", error);
    });
  });

  addon.on('search', ({ storefront, appID }, event) => {
    if (storefront !== 'steam') {
      event.resolve([]);
      return;
    }
    event.defer();
    
    const searchEffect = Effect.fn('searchEffect')(function* () {
      const steamResult = yield* Effect.tryPromise({
        try: async () => await addon.getAppDetails(appID, 'steam'),
        catch: () => new SteamSearchError({ query: String(appID) })
      });

      if (!steamResult) {
        return yield* Effect.fail(new SteamSearchError({ query: String(appID) }));
      }
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
        return yield* Effect.fail(new NoGameFoundError({ query: String(appID) }));
      }
      
      console.log("Found game", game.name);
      const resolutions = [{
        name: game.name,
        downloadType: 'request',
        manifest: {
          url: game.url
        }
      }] as SearchResult[];

      return resolutions;
    });

    pipe(
      searchEffect(),
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
      Effect.andThen(res => event.resolve(res)),
      Effect.runFork
    );
  });

  addon.on('request-dl', (appID, info, event) => {
    event.defer();

    const getDownloadLinks = Effect.try({
      try: () => {
        const url = info.manifest?.url;
        if (!url) throw new NoGameFoundError({ query: String(appID) });
        return scraper.scrapeGameDownloads(url);
      },
      catch: (e) => e instanceof NoGameFoundError ? e : new ScrapeGameDownloadsError({ game: String(appID) })
    });

    const findWorkingService = Effect.fn('findWorkingService')(function*(links: { service: string; url: string }[]) {
      const services = yield* pipe( 
        links,
        Effect.forEach(link => Effect.gen(function*() {
          console.log("Link", link);
          const serviceName = getServiceNameFromUrl(link.url);
          if (!serviceName) return null;
          const service = yield* getService(serviceName);
          return { name: serviceName, url: link.url, priority: service.priority };
        })),
        Effect.andThen(services => Effect.succeed(services.filter(s => !!s))),
        // priority is sorted from highest to lowest
        Effect.andThen(services => Effect.succeed(services.sort((a, b) => b.priority - a.priority)))
      );

      // Try each service in order, breaking out as soon as one works, using Effect for error handling
      // Fix: Avoid double-calling the for loop by not nesting Effect.gen inside Effect.either inside the for loop.
      // Instead, just use a single Effect.gen per service, and handle errors with try/catch.
      return Effect.gen(function*() {
        let lastError: unknown = null;
        console.log("Services", services);
        for (const serviceInfo of services) {
          try {
            console.log(`Trying service: ${serviceInfo.name}`);
            let service = yield* getService(serviceInfo.name);
            if (service.isCaptchaBased() && addon.config.getBooleanValue('disallowCaptchaBased')) {
              console.log('Skipping captcha based service', serviceInfo.name);
              continue;
            }

            let currentUrl = serviceInfo.url;

            if (service instanceof FileCryptService) {
              const fcResult = yield* service.scrapeDownloadLinks(currentUrl, event);
              if (fcResult.length === 0 || !fcResult[0].url) {
                throw new FileCryptError({ url: currentUrl, error: new Error('FileCrypt did not return a URL') });
              }
              const nextServiceName = getServiceNameFromUrl(fcResult[0].url);
              if (!nextServiceName) {
                throw new NoServiceFoundError();
              }
              service = yield* getService(nextServiceName);
              currentUrl = fcResult[0].url;
            }

            const downloadUrls = yield* service.scrapeDownloadLinks(currentUrl, event);
            if (downloadUrls.length > 0 && downloadUrls[0].url) {
              // Found a working service, break out
              return { url: downloadUrls[0].url, name: downloadUrls[0].name };
            }
            throw new NoDownloadFoundError();
          } catch (err) {
            lastError = err;
            // Continue to next service
          }
        }
        // If none worked, fail with the last error or a generic one
        return yield* Effect.fail(lastError ?? new NoDownloadFoundError());
      });
    });

    const requestDlEffect = Effect.fn('requestDlEffect')(function*() {
      const links = yield* getDownloadLinks;
      
      const downloadDetailsEither = yield* Effect.either(findWorkingService(yield* links));
      if (downloadDetailsEither._tag === 'Left') {
        return yield* Effect.fail(downloadDetailsEither.left);
      }
      const downloadDetails = yield* downloadDetailsEither.right;
      
      return {
        downloadType: 'direct',
        name: info.name,
        files: [{ name: downloadDetails.name, downloadURL: downloadDetails.url }]
      } as SearchResult;
    });

    pipe(
      requestDlEffect(),
      Effect.catchAll(error => {
        console.error("Error in request-dl:", error);
        event.fail('Failed to get download link');
        return Effect.fail(error);
      }),
      Effect.andThen(res => event.resolve(res)),
      Effect.runFork
    );
  });

  addon.on('setup', ({ path, multiPartFiles }, event) => {
    event.defer();
    console.log("Setup", path, multiPartFiles);
    const setupEffect = Effect.fn('setupEffect')(function*() {
      console.log("Setup", path, multiPartFiles);
      const file = multiPartFiles?.[0];
      if (!file) return yield* Effect.fail(new NoFileFoundError());

      // now, inferring that it's a rar file, we need to extract it to the "path" folder
      // use 7zip in the program files if this is a windows machine

      if (process.platform === 'win32') {
        const result = spawnSync('C:\\Program Files\\7-Zip\\7z.exe', [
          'x', // extract with full paths
          join(path, file.name), // input archive
          `-o${path}` // output directory
        ], { stdio: 'inherit' });
        if (result.error) {
          return yield* Effect.fail(new RarExtractionError({ path, error: result.error.message }));
        }
        if (result.status !== 0) {
          return yield* Effect.fail(new RarExtractionError({ path, error: `7z extraction failed with code ${result.status}` }));
        }
      }
      else if (process.platform === 'darwin' || process.platform === 'linux') {
        // use 'unrar' instead of 7z
        const result = spawnSync('unrar', [
          'x', // extract with full paths
          join(path, file.name), // input archive
          `${path}` // output directory
        ], { stdio: 'inherit' });
        if (result.error) {
          return yield* Effect.fail(new RarExtractionError({ path, error: result.error.message }));
        }
        if (result.status !== 0) {
          return yield* Effect.fail(new RarExtractionError({ path, error: `unrar extraction failed with code ${result.status}` }));
        }
      }

      // now, if there is a _CommonRedist folder, we need to put a boolean
      const hasCommonRedist = yield* Effect.tryPromise({
        try: async () => (await fs.stat(join(path, '_CommonRedist'))).isDirectory(),
        catch: () => false
      });

      // now check: if there are at least 2 folders in the path, and one is the _CommonRedist folder and the other is the game folder
      const folders = yield* Effect.tryPromise({
        try: async () => await fs.readdir(path),
        catch: () => []
      });
      const autoFoundGameFolder = yield* pipe(
        folders,
        Effect.forEach(folder => Effect.tryPromise({
          try: async () => [ folder, await fs.stat(join(path, folder)) ] as [string, Stats],
          catch: () => Effect.succeed(undefined)
        })),
        // filter to only folders
        Effect.andThen(folders => Effect.succeed(folders.filter(folder => folder && folder[1].isDirectory()))),
        // Now check if there are 2 folders, and one is the _CommonRedist folder and the other is the game folder
        Effect.andThen(folders => {
          if (folders.length !== 2) return Effect.succeed(undefined);
          if (folders.some(folder => folder[0] === '_CommonRedist') && folders.some(folder => folder[0] !== '_CommonRedist')) {
            return Effect.succeed(folders.find(folder => folder[0] !== '_CommonRedist')?.[0]);
          }
          return Effect.succeed(undefined);
        }),
      );

      let executables: string[] = [];
      if (autoFoundGameFolder) {
        console.log("Auto found game folder", autoFoundGameFolder, 'Searching for executables...');
        executables = yield* pipe(
          Effect.tryPromise({
            try: async () => await fs.readdir(join(path, autoFoundGameFolder)),
            catch: () => []
          }),
          Effect.andThen(executables => Effect.succeed(executables.filter(executable => executable.endsWith('.exe')))),
          Effect.andThen(executables => Effect.succeed(executables.map(executable => join(path, autoFoundGameFolder, executable))))
        );
        console.log("Found executables", executables);
      }

      // now it's time to build the ui for the setup
      const inputAsk = new ConfigurationBuilder()

      if (hasCommonRedist) {
        inputAsk.addBooleanOption(option => 
          option.setName('runCommonRedist')
            .setDisplayName('Run Common Redistributables')
            .setDescription('Run the Common Redistributables (Useful if you are downloading a game from Steamrip for the first time, or if you don\t know if you need it).')
            .setDefaultValue(true)
        );
      }
      if (!autoFoundGameFolder) {
        inputAsk.addStringOption(option => 
          option.setName('cwd')
            .setDisplayName('Game Folder')
            .setDescription('Game folder to run the game from. This is the folder that contains the game executable.')
            .setInputType('file')
            .setDefaultValue('')
        );
      }
      if (executables.length >= 0 && executables.length !== 1) {
        if (executables.length > 1) {
          inputAsk.addStringOption(option => 
            option.setName('executable')
              .setDisplayName('Executable Path')
              .setDescription('Executable path to run the game (ends in .exe). This will be inside of the game folder.')
              .setAllowedValues(executables.map(executable => executable.split(path)[1]))
              .setInputType('text')
              .setDefaultValue(executables[0])
          );
        }
        else {
          inputAsk.addStringOption(option => 
            option.setName('executable')
              .setDisplayName('Executable Path')
              .setDescription('Executable path to run the game (ends in .exe). This will be inside of the game folder.')
              .setInputType('file')
              .setDefaultValue('')
          );
        }
      }

      const input = yield* Effect.tryPromise({
        try: async () => await event.askForInput('Setup your Game', 'Setup your new game', inputAsk),
        catch: () => Effect.fail(new InputError({ error: 'Failed to ask for input' }))
      });

      // if the 'run common redist' is true, we need to run the common redistributables
      if (input.runCommonRedist) {
        const commonRedist = yield* Effect.tryPromise({
          try: async () => await fs.readdir(join(path, '_CommonRedist')),
          catch: () => Effect.fail(new NoFileFoundError())
        });
        if (commonRedist.length === 0) {
          return yield* Effect.fail(new NoFileFoundError());
        }
        const commonRedistExecutables = commonRedist.filter(file => file.endsWith('.exe'));
        if (commonRedistExecutables.length === 0) {
          return yield* Effect.fail(new NoFileFoundError());
        }

        // now spawn all of the common redistributables one at a time, to prevent overstimulating
        for (const file of commonRedistExecutables) {
          const result = yield* Effect.try({
            try: () => spawnSync(join(path, '_CommonRedist', file), { stdio: 'inherit' }),
            catch: (e) => e instanceof Error ? new CommonRedistError({ path, error: e.message }) : new CommonRedistError({ path, error: 'Unknown error' })
          });
          if (result.error) {
            return yield* Effect.fail(new CommonRedistError({ path, error: result.error.message }));
          }
        }
      }
      if (autoFoundGameFolder) {
        input.cwd = join(path, autoFoundGameFolder);
      }

      if (executables.length >= 0 && executables.length !== 1) {
        // match the input.executable to an actual path
        input.executable = join(path, input.executable as string).split(path)[1];
      }

      if (executables.length === 1) {
        input.executable = executables[0];
      }

      const response: Parameters<typeof event.resolve>[0] = {
        cwd: input.cwd as string,
        launchExecutable: input.executable as string,
        version: '1.0',
        launchArguments: '%command%'
      };
      return yield* Effect.succeed(response);
    });

    pipe(
      setupEffect(),
      Effect.catchAll(error => {
        console.error("Error setting up", error);
        event.fail('Failed to setup');
        return Effect.fail(error);
      }),
      Effect.andThen(res => event.resolve(res)),
      Effect.runFork
    )
  });

  addon.on('disconnect', () => {
    process.exit(0);
  }); 

});

BunRuntime.runMain(pipe(
  program,
  Effect.provide(addonService)
));
