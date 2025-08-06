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
import { join, relative } from "path";
import { spawnSync, execSync, spawn } from "child_process";
import * as fs from 'fs/promises';
import { existsSync, type Stats } from "fs";
import axios from "axios";
import { Stream } from "stream";
import { cloudflareSolve } from "./lib/cloudflare";
import { headerManager } from "./lib/header-manager";

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
    // Normalize and clean the strings
    const normalize = (str: string): string => {
      return str
        .toLowerCase()
        // Remove common download-related suffixes
        .replace(/\s+(free\s+)?download.*$/i, '')
        // Remove version patterns like (v1.2.3), [v1.2.3], etc.
        .replace(/[\(\[\{]v?[\d\.]+[\)\]\}]/gi, '')
        // Remove year patterns like (2023), [2024], etc.
        .replace(/[\(\[\{]\d{4}[\)\]\}]/g, '')
        // Remove edition suffixes but keep them for partial matching
        .replace(/\s+(premium|deluxe|gold|ultimate|complete|goty|game\s+of\s+the\s+year|enhanced|definitive|remastered|directors?\s+cut)\s+(edition)?/gi, '')
        // Clean up extra whitespace
        .replace(/\s+/g, ' ')
        .trim();
    };

    const cleanA = normalize(a);
    const cleanB = normalize(b);

    // Return early for exact equality after normalization
    if (cleanA === cleanB) return 1;

    // Split into words for word-level matching
    const wordsA = cleanA.split(/\s+/).filter(word => word.length > 0);
    const wordsB = cleanB.split(/\s+/).filter(word => word.length > 0);

    if (wordsA.length === 0 || wordsB.length === 0) return 0;

    // Calculate word-level similarity
    let exactMatches = 0;
    let partialMatches = 0;
    const usedWordsB = new Set<number>();

    for (const wordA of wordsA) {
      let bestMatch = 0;
      let bestMatchIndex = -1;

      for (let i = 0; i < wordsB.length; i++) {
        if (usedWordsB.has(i)) continue;

        const wordB = wordsB[i];
        
        // Exact word match
        if (wordA === wordB) {
          exactMatches++;
          usedWordsB.add(i);
          bestMatchIndex = i;
          break;
        }

        // Partial word match using character overlap
        const overlap = calculateCharacterOverlap(wordA, wordB);
        if (overlap > bestMatch && overlap > 0.6) {
          bestMatch = overlap;
          bestMatchIndex = i;
        }
      }

      // If we found a good partial match and haven't used exact match
      if (bestMatchIndex !== -1 && !usedWordsB.has(bestMatchIndex) && bestMatch > 0) {
        partialMatches++;
        usedWordsB.add(bestMatchIndex);
      }
    }

    // Calculate similarity score
    // Give more weight to exact matches, some weight to partial matches
    const totalWords = Math.max(wordsA.length, wordsB.length);
    const exactScore = exactMatches / totalWords;
    const partialScore = (partialMatches * 0.7) / totalWords;
    
    return Math.min(1, exactScore + partialScore);

    function calculateCharacterOverlap(str1: string, str2: string): number {
      if (str1.length < 2 || str2.length < 2) return str1 === str2 ? 1 : 0;
      
      const bigrams1 = new Set<string>();
      const bigrams2 = new Set<string>();
      
      for (let i = 0; i < str1.length - 1; i++) {
        bigrams1.add(str1.substring(i, i + 2));
      }
      
      for (let i = 0; i < str2.length - 1; i++) {
        bigrams2.add(str2.substring(i, i + 2));
      }
      
      const intersection = [...bigrams1].filter(bg => bigrams2.has(bg)).length;
      const union = bigrams1.size + bigrams2.size - intersection;
      
      return union > 0 ? intersection / union : 0;
    }
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
    .addBooleanOption(option => option
      .setName('clearCloudflareCookies')
      .setDisplayName('Clear Cloudflare Cookies')
      .setDescription('Clear stored Cloudflare cookies on next connect (useful if you encounter issues).')
      .setDefaultValue(false)
    )
  )

  addon.on('connect', () => {
    const connectEffect = Effect.fn('connectEffect')(function*() {
      const task = yield* Effect.tryPromise({
        try: () => addon.task(),
        catch: () => new Error('Failed to create task') // Define a specific error if needed
      });

      yield* Effect.sync(() => task.log('Checking Cloudflare protection...'));
      
      // // Check if user wants to clear headers
      if (addon.config.getBooleanValue('clearCloudflareCookies') ?? false) {
        yield* Effect.sync(() => task.log('Clearing Cloudflare headers as requested...'));
        yield* headerManager.clearHeaders();
      }
      
      // Load existing headers first
      yield* headerManager.loadHeaders();
      
      // Check if we need to solve Cloudflare
      const cloudflareResult = yield* cloudflareSolve('https://steamrip.com', addon);
      
      if (cloudflareResult) {
        yield* Effect.sync(() => task.log('Cloudflare headers obtained and stored.'));
      } else {
        yield* Effect.sync(() => task.log('No Cloudflare protection detected.'));
      }

      yield* Effect.sync(() => task.log('Cleaning up expired scrapes...'));
      yield* scraper.cleanupExpiredScrapes();
      
      // Log scrape statistics
      const stats = yield* scraper.getScrapeStats();
      yield* Effect.sync(() => task.log(`Scrape cache: ${stats.valid} valid, ${stats.expired} expired, ${stats.total} total files`));
      
      yield* Effect.sync(() => task.log('Implementing local catalog...'));
      yield* scraper.upgradeLocals();
      yield* Effect.sync(() => task.log('Processing local catalog...'));
      yield* scraper.processLocals();
      yield* Effect.sync(() => search.addItems(scraper.catalog.games));
      yield* Effect.sync(() => task.finish());
    });

    Effect.runPromise(connectEffect()).catch(error => {
      console.error("Error during connect:", error);
      // Show user-friendly error message for Cloudflare failures
      if (error.message && (error.message.includes('Cloudflare') || error.message.includes('cf_') || error.message.includes('No valid Cloudflare headers'))) {
        addon.notify({
          message: 'Failed to solve Cloudflare protection. Please try again or check your internet connection.',
          id: 'cloudflare-error',
          type: 'error',
        });
      }
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
      const SIMILARITY_THRESHOLD = 0.4;
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
      Effect.catchAll((error: unknown) => {
        console.error("Search error:", error);
        if (error instanceof Error && error.message && error.message.includes('No valid Cloudflare headers')) {
          addon.notify({
            message: 'Cloudflare headers are missing. Please reconnect to solve Cloudflare protection.',
            id: 'cloudflare-headers-missing',
            type: 'warning',
          });
        }
        return Effect.succeed([]);
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
              const fcResult = yield* pipe(
                service.scrapeDownloadLinks(currentUrl, event),
                Effect.catchAll(e => Effect.succeed([]))
              )
              if (fcResult.length === 0 || !fcResult[0].url) {
                // throw new FileCryptError({ url: currentUrl, error: new Error('FileCrypt did not return a URL') });
                console.log('FileCrypt did not return a URL', fcResult);
                continue;
              }
              const nextServiceName = getServiceNameFromUrl(fcResult[0].url);
              if (!nextServiceName) {
                console.log('No service found', fcResult[0].url);
                continue;
              }
              service = yield* getService(nextServiceName);
              currentUrl = fcResult[0].url;
            }

            const downloadUrls = yield* pipe(
              service.scrapeDownloadLinks(currentUrl, event),
              Effect.catchAll(e => Effect.succeed([]))
            ); 
            console.log('download found', downloadUrls);
            // test the download links to see if we can get a 200 response
            let linksGood = true;
            // for (const downloadUrl of downloadUrls) {
            //   const response = yield* Effect.tryPromise({
            //     try: async () => await axios<Stream.Readable>(downloadUrl.url, {
            //       responseType: 'stream',
            //       headers: {
            //         'User-Agent': 'OpenGameLauncher/1.0'
            //       }
            //     }),
            //     catch: (err) => {
            //       console.log('Error', err);
            //       return Effect.succeed(undefined);
            //     }
            //   });
            //   console.log('Response', response.status);

            //   response.data.destroy();
            //   if (response?.status !== 200) {
            //     linksGood = false;
            //     break;
            //   }
            // }

            if (!linksGood) {
              console.log('No working links found', downloadUrls);
              continue;
            }
            if (downloadUrls.length === 0) {
              console.log('No download urls found', downloadUrls);
              continue;
            }
            // Found a working service, break out
            return { url: downloadUrls[0].url, name: downloadUrls[0].name, headers: downloadUrls[0].headers };
          } catch (err) {
            lastError = err;
            // Continue to next service
          }
        }
        // If none worked, fail with the last error or a generic one
        addon.notify({
          id: 'no-download-found-steamrip',
          message: 'No download supported found for ' + info.name,
          type: 'error'
        })
        yield* Effect.promise(async () => await event.askForInput('No download link supported', 'You are seeing this message because there isn\'t a service that we currently support to download this game. We are slowly working towards 100% coverage, so please be patient!', new ConfigurationBuilder()));
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
        files: [{ name: downloadDetails.name, downloadURL: downloadDetails.url, headers: downloadDetails.headers }]
      } as SearchResult;
    });

    pipe(
      requestDlEffect(),
      Effect.catchAll((error: unknown) => {
        console.error("Error in request-dl:", error);
        if (error instanceof Error && error.message && error.message.includes('No valid Cloudflare headers')) {
          addon.notify({
            message: 'Cloudflare headers are missing. Please reconnect to solve Cloudflare protection.',
            id: 'cloudflare-headers-missing',
            type: 'warning',
          });
        }
        event.fail('Failed to get download link');
        return Effect.fail(error);
      }),
      Effect.andThen(res => event.resolve(res)),
      Effect.runFork
    );
  });

  addon.on('setup', ({ path, multiPartFiles }, event) => {
    event.log(`Setup: path: ${path}, multiPartFiles: ${multiPartFiles}`);
    event.defer();
    const setupEffect = Effect.fn('setupEffect')(function*() {
      const programFiles7zip = join(process.env['ProgramFiles'] || 'C:\\Program Files', '7-Zip', '7z.exe');
      const file = multiPartFiles?.[0];
      console.log("File", file);
      if (!file) return yield* Effect.fail(new NoFileFoundError());

      const showErrorScreen = async () => {
        await event.askForInput('Error', 'Oops! It seems like this game wans\'t downloaded correctly. Go to the path: "' + path + '" and delete the file to try again. It is likely that this game is hosted on a service that is not currently working. Stay subscribed to the thread to get notified when it is fixed.', new ConfigurationBuilder())
      }

      event.log('Waiting for zip to be unlocked by OpenGameInstaller...');
      yield* Effect.sleep(1000);

      // now, inferring that it's a rar file, we need to extract it to the "path" folder
      // use 7zip in the program files if this is a windows machine

      // if there are other files in this path other than the input archive, we need to delete them
      const files = yield* Effect.tryPromise({
        try: async () => await fs.readdir(path),
        catch: () => []
      });
      if (files.length > 1) {
        event.log('Found other files in the path, deleting them...');
        console.log("Files", files);
        for (const fileName of files) {
          if (fileName !== file.name) {
            const result = yield* pipe(
              Effect.tryPromise({
                try: async () => {
                  await fs.rm(join(path, fileName), { force: true, recursive: true, maxRetries: 3, retryDelay: 1000 });
                  return true;
                },
                catch: () => {
                  console.error('Error deleting file', fileName);
                  return false;
                }
              }),
              Effect.catchAll(e => {  
                console.error('Error deleting file', fileName);
                return Effect.succeed(false);
              })
            );
            console.log("Result in deleting file:", fileName, result);
          }
        }
      }
      event.log('Extracting archive (this may take a while). We recommend to check the folder in ' + path + ' to see if the extraction is progressing.')
      if (process.platform === 'win32') {
        const command = `"${programFiles7zip}" x "${join(path, file.name)}" -o"${path}" -y`;
        event.log(`Running command: ${command}`);
        try {
          execSync(command, { stdio: 'inherit' });
        } catch (error) {
          console.error('Error extracting archive', error);
          yield* Effect.promise(async () => showErrorScreen());
          return yield* Effect.fail(new RarExtractionError({ path, error: (error as Error).message }));
        }
      }
      else if (process.platform === 'darwin' || process.platform === 'linux') {
        // use 'unrar' instead of 7z
        console.log(join(path, file.name));
        const result = yield* Effect.tryPromise({
          try: () => new Promise<{ error?: Error; status: number }>((resolve) => {
            const child = spawn('unrar', [
              'x', // extract with full paths
              join(path, file.name), // input archive
              `${path}`, // output directory
              '-y' // say yes to all prompts
            ], { stdio: 'ignore' });

            child.on('error', (error) => {
              resolve({ error, status: 1 });
            });

            child.on('close', (code) => {
              resolve({ status: code ?? 1 });
            });
          }),
          catch: (error) => ({ error: error as Error, status: 1 })
        });
        console.log(result);
        if (result.error) {
          console.error('Error extracting archive', result);
          console.error('Error extracting archive', result.error);
          yield* Effect.promise(async () => showErrorScreen());
          return yield* Effect.fail(new RarExtractionError({ path, error: result.error.message }));
        }
        if (result.status !== 0) {
          console.error('Error extracting archive', result.status);
          yield* Effect.promise(async () => showErrorScreen());
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
      let autoFoundGameFolder = yield* pipe(
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
            try: async () => await fs.readdir(join(path, autoFoundGameFolder as string)),
            catch: () => []
          }),
          Effect.andThen(executables => Effect.succeed(executables.filter(executable => executable.endsWith('.exe')))),
          Effect.andThen(executables => Effect.succeed(executables.map(executable => join(path, autoFoundGameFolder as string, executable))))
        );
        console.log("Found executables", executables);
        if (executables.length === 0) {
          event.log('No executables found in the game folder');
          autoFoundGameFolder = undefined;
        }
      }

      // now it's time to build the ui for the setup
      const inputAsk = new ConfigurationBuilder()
      let addedInput = false;
      if (hasCommonRedist) {
        addedInput = true;
        inputAsk.addBooleanOption(option => 
          option.setName('runCommonRedist')
            .setDisplayName('Run Common Redistributables')
            .setDescription('Run the Common Redistributables (Useful if you are downloading a game from Steamrip for the first time, or if you don\'t know if you need it).')
            .setDefaultValue(true)
        );
      }
      if (!autoFoundGameFolder) {
        addedInput = true;
        inputAsk.addStringOption(option => 
          option.setName('cwd')
            .setDisplayName('Game Folder')
            .setDescription('Game folder to run the game from. This is the folder that contains the game executable.')
            .setInputType('folder')
            .setDefaultValue('')
        );
      }
      if (executables.length >= 0 && executables.length !== 1) {
        addedInput = true;
        if (executables.length > 1) {
          inputAsk.addStringOption(option => 
            option.setName('executable')
              .setDisplayName('Executable Path')
              .setDescription('Executable path to run the game (ends in .exe). This will be inside of the game folder.')
              .setAllowedValues(executables.map(executable => relative(path, executable)))
              .setInputType('text')
              .setDefaultValue(relative(path, executables[0]))
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
      let input: {[ key: string ]: string | boolean | number } = {};
      if (addedInput) {
        input = yield* Effect.tryPromise({
          try: async () => await event.askForInput('Setup your Game', 'Setup your new game', inputAsk),
          catch: () => Effect.fail(new InputError({ error: 'Failed to ask for input' }))
        });
      }

      // if the 'run common redist' is true, we need to run the common redistributables
      // let commonRedistExecutables: { name: string, path: string }[] = [];
      // if (input.runCommonRedist) {
      //   const commonRedist = yield* Effect.tryPromise({
      //     try: async () => await fs.readdir(join(path, '_CommonRedist')),
      //     catch: () => Effect.fail(new NoFileFoundError())
      //   });
      //   if (commonRedist.length === 0) {
      //     return yield* Effect.fail(new NoFileFoundError());
      //   }
      //   const redistributables = commonRedist.filter(file => file.endsWith('.exe') || file.endsWith('.msi'));
      //   if (redistributables.length === 0) {
      //     return yield* Effect.fail(new NoFileFoundError());
      //   }
      //   // join path to common redist
      //   commonRedistExecutables = redistributables.map(file => ({ name: file, path: join(path, '_CommonRedist', file) }));
      //   // order so that xna is last
      //   commonRedistExecutables = commonRedistExecutables.sort((a, b) => {
      //     if (a.name.toLowerCase().includes('xna')) return 1;
      //     if (b.name.toLowerCase().includes('xna')) return -1;
      //     return 0;
      //   });
      //   // append to the front microsoft c# runtime
      //   if (process.platform === 'linux') {
      //     // remove the dotNet from the commonRedistExecutables
      //     commonRedistExecutables = commonRedistExecutables.filter(file => !file.name.toLowerCase().includes('dotnet'));

      //     // append to the front dotnet
      //     commonRedistExecutables = [ { name: 'dotnet48', path: 'winetricks' }, ...commonRedistExecutables ]

      //     // remove everyting that's dxwebsetup
      //     commonRedistExecutables = commonRedistExecutables.filter(file => !file.name.toLowerCase().includes('dxwebsetup'));
      //   }
      // }
      if (autoFoundGameFolder) {
        input.cwd = join(path, autoFoundGameFolder);
      }

      if (executables.length >= 0 && executables.length !== 1) {
        // match the input.executable to an actual path
        input.executable = join(path, input.executable as string);
      }

      if (executables.length === 1) {
        input.executable = executables[0];
      }

      // then remove the download path
      yield* Effect.tryPromise({
        try: async () => await fs.rm(join(path, file.name), { maxRetries: 3, retryDelay: 1000 }),
        catch: () => {
          console.log('Failed to auto remove download path', join(path, file.name));
          return Effect.succeed(undefined);
        }
      });

      const response: Parameters<typeof event.resolve>[0] = {
        cwd: input.cwd as string,
        launchExecutable: input.executable as string,
        version: '1.0',
        // redistributables: commonRedistExecutables,
        redistributables: [],
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
