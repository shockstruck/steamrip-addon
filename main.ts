import { JSDOM } from 'jsdom';
import OGIAddon, { ConfigurationBuilder, EventResponse, SearchTool, type SetupEventResponse, type SearchResult } from "ogi-addon";
import Scraper from "./lib/scraper";
import { getService, getServiceNameFromUrl } from "./lib/services/matcher";
import FileCryptService from "./lib/services/FileCrypt";
import { Context, Effect, Layer, Match, pipe } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import { CommonRedistError, FileCryptError, InputError, NoDownloadFoundError, NoFileFoundError, NoGameFoundError, NoServiceFoundError, NotOnlineError, RarExtractionError, ScrapeGameDownloadsError, SteamSearchError } from "./lib/errors";
import { dirname, join, relative } from "path";
import { spawnSync, execSync, spawn } from "child_process";
import * as fs from 'fs/promises';
import { existsSync, type Stats } from "fs";
import axios from "axios";
import { Stream } from "stream";
import { cloudflareSolve, CloudflareTestError } from "./lib/cloudflare";
import { headerManager } from "./lib/header-manager";
import { connectRealBrowser, PUPPETEER_OPTIONS } from "./lib/services/BaseService";
import { applySetupOverrides } from "./lib/app-overrides";

const baseAddon = new OGIAddon({
  name: 'Steamrip Tool',
  version: '1.0.0',
  id: 'steamrip-addon',
  author: 'fat-addons',
  description: 'An addon to scrape steamrip and provide direct download links.',
  repository: 'https://gitlab.com/fat-addons/steamrip-addon',
  storefronts: [ 'steam' ]

});

export class AddonService extends Context.Tag('AddonService')<AddonService, {
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

  const scraper = new Scraper();
  const search = new SearchTool<{ name: string, url: string }>([], ['name']);

  const { addon, stringSimilarity } = yield* AddonService;
  
  addon.on('configure', (config) => config
    .addBooleanOption(option => option
      .setName('manualSelect')
      .setDisplayName('Service Selection')
      .setDescription('Manually select the service you want to use for downloading games. Useful for services who rate limit or have download limits.')
      .setDefaultValue(false)
    )
    .addBooleanOption(option => option
      .setName('disallowCaptchaBased')
      .setDisplayName('Disallow Captcha Based Services')
      .setDescription('Disallow services that require a captcha to be solved.')
      .setDefaultValue(false)
    )
    .addActionOption(option => 
      option
        .setName('clearCloudflareCookies')
        .setDisplayName('Clear Cloudflare Cookies')
        .setDescription('Clear the Cloudflare cookies from the browser.')
        .setTaskName('clearCloudflareCookies')
        .setButtonText('Clear')
    )
    .addActionOption(option => option
      .setName('clearDownloadCache')
      .setDisplayName('Clear Steamrip Cache')
      .setDescription('Clear the Steamrip cache from the device.')
      .setTaskName('clearDownloadCache')
      .setButtonText('Clear')
    )
  )

  addon.onTask('clearCloudflareCookies', (task) => Effect.gen(function*() {
    yield* headerManager.clearHeaders();
    yield* Effect.sync(() => task.log('Cloudflare cookies cleared.'));
    yield* Effect.sync(() => task.complete());
  }).pipe(Effect.runPromise));
  addon.onTask('clearDownloadCache', (task) => Effect.gen(function*() {
    yield* scraper.cleanupAllScrapes();
    yield* Effect.sync(() => task.log('Steamrip cache cleared.'));
    yield* Effect.sync(() => task.complete());
  }).pipe(Effect.runPromise));

  addon.on('connect', (event) => {
    const connectEffect = Effect.fn('connectEffect')(function*() {
      const task = yield* Effect.tryPromise({
        try: () => addon.task(),
        catch: () => new Error('Failed to create task') // Define a specific error if needed
      });

      // check if the system is online first, and if not, then abort mission!
      console.log('Checking online...');
      yield* Effect.tryPromise({
        try: async () => axios({
          url: 'https://google.com',
          timeout: 5000
        }),
        catch: () => new NotOnlineError()
      }).pipe(
        Effect.tap((out) => console.log(out)),
        Effect.catchTag('NotOnlineError', (_) => {
          addon.notify({
            id: String(Math.floor(Math.random() * 10000)),
            message: 'Steamrip Addon: Cannot access network check, stopping addon.',
            type: 'error'
          })

          return Effect.dieMessage('Cannot access network check')
        }),
      )
      // check if we're on linux, and if so, run CHROME_PATH="$(flatpak info --show-location org.chromium.Chromium)/files/chromium/chrome" to set the chrome path
      if (process.platform === 'linux') {
        console.log('Setting CHROME_PATH for this device.');
        yield* Effect.try(() => {
          const flatpakPath = execSync('flatpak info --show-location org.chromium.Chromium').toString().trim();
          process.env.CHROME_PATH = join(flatpakPath, 'files', 'chromium', 'chrome');
        }).pipe(Effect.catchAll((err) => {
          console.log('Error in setting CHROME_PATH for this device. Hopefully everything still works..', err);
          return Effect.succeed(undefined);
        }));
        console.log('CHROME_PATH set to', process.env.CHROME_PATH);
      }
      // check if chrome is installed on the device, and we can spawn a puppeteer-real-browser process
      // Set protocol timeout via environment variable to avoid Runtime.callFunctionOn timeout
      process.env.PUPPETEER_PROTOCOL_TIMEOUT = String(PUPPETEER_OPTIONS.protocolTimeout || 180000);
      const chromeInstalled = yield* Effect.tryPromise(() => connectRealBrowser({ headless: true, disableXvfb: true })).pipe(Effect.catchAll((err) => {
        console.log('Error:', err);
        return Effect.succeed(undefined);
      }));
      if (!chromeInstalled) {
        yield* Effect.sync(() => task.log('Chrome/Chromium is not installed on the device. Please install it and try again.'));
        yield* Effect.sync(() => task.complete());
        yield* Effect.sync(() => addon.notify({
          message: 'Steamrip requires Chrome/Chromium to be installed on the device for accessing Steamrip.com',
          id: 'str-chrome-not-installed',
          type: 'error',
        }));

        yield* Effect.promise(async () => await event.askForInput('(1/3) Chrome/Chromium is not installed', 'Steamrip Addon requires Chrome/Chromium to be installed on the device for accessing Steamrip.com', new ConfigurationBuilder()));
        if (process.platform === 'linux') {
          yield* Effect.promise(async () => await event.askForInput('(2/3) Chrome/Chromium is not installed', 'Because you are on Linux, download the Flatpak version of Chromium from Discover or the CLI using flatpak install flathub org.chromium.Chromium', new ConfigurationBuilder()));
          yield* Effect.promise(async () => await event.askForInput('(3/3) Chrome/Chromium is not installed', 'Once you have installed it, please restart the addon server and try again.', new ConfigurationBuilder()));
        }
        else {
          yield* Effect.promise(async () => await event.askForInput('(2/3) Chrome/Chromium is not installed', 'Because you are on Windows, download the Chrome browser from the official website and install it.', new ConfigurationBuilder()));
          yield* Effect.promise(async () => await event.askForInput('(3/3) Chrome/Chromium is not installed', 'Once you have installed it, please restart the addon server and try again.', new ConfigurationBuilder()));
        }
        return;
      }
      yield* Effect.sync(() => task.log('Chrome is installed on the device.'));
      console.log('Chrome is installed on the device.');
      yield* Effect.promise(async () => await chromeInstalled.browser.close());



      yield* Effect.sync(() => task.log('Checking Cloudflare protection...'));
      
      // Check if user wants to clear headers
      // if (addon.config.getBooleanValue('clearCloudflareCookies') ?? false) {
      //   yield* Effect.sync(() => task.log('Clearing Cloudflare headers as requested...'));
      //   yield* headerManager.clearHeaders();
      // }
      
      // Load existing headers first
      yield* headerManager.loadHeaders();
      
      // Check if we need to solve Cloudflare
      const cloudflareResult = yield* pipe(
        cloudflareSolve('https://steamrip.com', addon),
        Effect.catchAll((er) => {
          console.error('Error solving Cloudflare:', er);
          return Effect.succeed(undefined);
        })
      );
      
      if (cloudflareResult) {
        yield* Effect.sync(() => task.log('Cloudflare headers obtained and stored.'));
      } else {
        yield* Effect.sync(() => task.log('No Cloudflare protection detected.'));
      }

      if (cloudflareResult === undefined) {
        yield* Effect.sync(() => task.log('Seems like we cannot access steamrip.com. Please check your internet connection and try again.'));
        yield* Effect.sync(() => task.complete());
        addon.notify({
          message: 'Seems like we cannot access steamrip.com. Please check your internet connection and try again.',
          id: 'steamrip-cloudflare-error',
          type: 'error',
        });
        return;
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
      yield* Effect.sync(() => addon.notify({
        message: 'Steamrip Cloudflare Solved.',
        id: 'steamrip-cloudflare-solved',
        type: 'success',
      }));
      yield* Effect.sync(() => task.complete());
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

  addon.on('search', (info, event) => {
    const { for: forType } = info;
    if (forType === 'task') {
      event.resolve([]);
      return;
    }

    const { storefront, appID } = info;
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

      // if this is an update, we need to check if the game has already been downloaded
      if (forType === 'update') {
        const { cwd } = info.libraryInfo;
        const steamripInfo = yield* Effect.tryPromise(
          async () => await fs.readFile(join(cwd as string, 'steamrip-info.json'), 'utf8'),
        ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
        if (steamripInfo) {
          const { title } = JSON.parse(steamripInfo);
          if (title === game.name) {
            console.log("Game already downloaded.", game.name);
            return [
              {
                name: 'You have the latest version Steamrip has for this game.',
                downloadType: 'empty',
              } as SearchResult
            ];
          }
        }
      }
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

    const findWorkingService = Effect.fn('findWorkingService')(function*(links: { service: string; url: string }[], event: EventResponse<SearchResult>) {
      // Use correct effect piping, types, and avoid 'any'

      type Link = { service: string; url: string };
      type ServiceInfo = { name: string; url: string; priority: number };

      const services = yield* pipe(
        Effect.succeed(links as Link[]),
        Effect.andThen((links) => {
          if (addon.config.getBooleanValue('manualSelect') ?? false) {
            return Effect.promise(async () => {
              const options = links.map(link => link.service);
              const config = new ConfigurationBuilder()
                .addStringOption(option =>
                  option
                    .setName('service')
                    .setDisplayName('Service')
                    .setDescription('Please select the service you want to use for downloading this game.')
                    .setAllowedValues(options)
                );
              const input = await event.askForInput(
                'Manual Service Selection',
                'Please select the service you want to use for downloading this game.',
                config
              );
              const selectedLink = links.find(link => link.service === input.service);
              return selectedLink ? [selectedLink] : links;
            });
          }
          return Effect.succeed(links);
        }),
        Effect.andThen((links) =>
          Effect.forEach(links, (link) =>
            Effect.gen(function* () {
              const serviceName = getServiceNameFromUrl(link.url);
              if (!serviceName) return null;
              const service = yield* getService(serviceName);
              return {
                name: serviceName,
                url: link.url,
                priority: service.priority
              } as ServiceInfo;
            })
          )
        ),
        Effect.map((serviceInfos) =>
          serviceInfos
            .filter((s): s is ServiceInfo => !!s)
            .sort((a, b) => b.priority - a.priority)
        )
      );

      return yield* Effect.gen(function*() {
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
              Effect.catchAll(e => { 
                console.error('Error', e);
                return Effect.succeed([]);
              })
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
        yield* Effect.promise(async () => await event.askForInput('No download link supported', 'You are seeing this message because there was an issue with downloading the game through one of the services. Please try again, and if you still can\'t download it, please report the issue to the thread.', new ConfigurationBuilder()));
        return yield* Effect.fail(lastError ?? new NoDownloadFoundError());
      });
    });

    const requestDlEffect = Effect.fn('requestDlEffect')(function*() {
      const links = yield* getDownloadLinks;
      
      const downloadDetails = yield* findWorkingService(yield* links, event);
      
      
      return {
        downloadType: 'direct',
        name: info.name,
        files: [{ name: downloadDetails.name, downloadURL: downloadDetails.url, headers: downloadDetails.headers }],
        manifest: info.manifest
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

  addon.on('setup', ({ path, type, multiPartFiles, appID, manifest, for: forType }, event) => {
    if (type === 'empty') {
      event.fail('Game already downloaded.');
      return;
    }
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

      // Get Steam App Details
      let appDetails = yield* Effect.tryPromise(async () => await addon.getAppDetails(appID, 'steam'))
        .pipe(Effect.catchAll(_ => Effect.succeed(undefined)));

      // Get Latest Version
      let latestVersion = (appDetails?.latestVersion ?? '1.0').trim();

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
          catch: () => undefined
        }), { concurrency: 'unbounded' }),
        // filter to only folders
        Effect.map(folders => folders.filter(folder => folder && folder[1].isDirectory())),
        // Now check if there are 2 folders, and one is the _CommonRedist folder and the other is the game folder
        Effect.map(folders => {
          if (folders.length !== 2) return undefined;
          if (folders.some(folder => folder[0] === '_CommonRedist') && folders.some(folder => folder[0] !== '_CommonRedist')) {
            return folders.find(folder => folder[0] !== '_CommonRedist')?.[0];
          }
          return undefined;
        }),
      );
      
      if (autoFoundGameFolder) {
        // move all the contents in that folder into the path
        yield* Effect.tryPromise({
          try: async () => {
            const contents = await fs.readdir(join(path, autoFoundGameFolder as string));
            for (const content of contents) {
              await fs.rename(join(path, autoFoundGameFolder as string, content), join(path, content));
            }
            await fs.rmdir(join(path, autoFoundGameFolder as string), { recursive: true });
            return undefined;
          },
          catch: () => {
            console.log('Failed to move folder', join(path, autoFoundGameFolder as string));
            return Effect.succeed(undefined);
          }
        });
      }

      let executables: string[] = [];
      if (autoFoundGameFolder) {
        console.log("Auto found game folder", autoFoundGameFolder, 'Searching for executables...');
        executables = yield* pipe(
          Effect.tryPromise({
            try: async () => await fs.readdir(path),
            catch: () => []
          }),
          Effect.map(executables => executables.filter(executable => executable.endsWith('.exe'))),
          // remove UnityCrashHandler
          Effect.map(executables => executables.filter(executable => !executable.toLowerCase().includes('unitycrashhandler'))),
          // remove uninstall00.exe
          Effect.map(executables => executables.filter(executable => !executable.toLowerCase().includes('unins000.exe'))),
          Effect.map(executables => executables.map(executable => join(path, executable)))
        );
        console.log("Found executables", executables);
        if (executables.length === 0) {
          event.log('No executables found in the game folder');
          autoFoundGameFolder = undefined;
        }
      }


      // Lossless Scaling Has Some Unique Properties
      if (appID === 993090 && process.platform === 'linux') {
        // check if the executable is "LosslessScaling.exe"
        if (executables.some(executable => executable.toLowerCase().includes('losslessscaling.exe'))) {
          // move the entire directory of the cwd to path /home/{user}/.steam/steamapps/common/Lossless Scaling
          let newPath = join('/home/', process.env.USER as string, '.steam/steamapps/common/Lossless Scaling');
          yield* Effect.tryPromise({
            try: async () => await fs.rename(path, newPath),
            catch: () => {
              console.error('Error moving directory', newPath);
              return Effect.succeed(undefined);
            }
          })
            
          path = newPath;
          executables = executables.map(executable => executable.replace(path, newPath));
          // then just resolve everything and return
          const losslessResponse: SetupEventResponse = {
            cwd: newPath,
            launchExecutable: executables[0],
            version: latestVersion,
            redistributables: [],
            launchArguments: '%command%',
            umu: {
              umuId: `steam:${appID}`,
              dllOverrides: [],
              protonVersion: 'UMU-Latest'
            }
          };
          return yield* Effect.succeed(
            applySetupOverrides(appID, losslessResponse, {
              appID,
              platform: process.platform,
              installPath: newPath,
              executablePath: executables[0],
              dllOverrides: [],
            })
          );
        }
      }

      // now it's time to build the ui for the setup
      let inputAsk = new ConfigurationBuilder()
      let addedInput = false;
      // On Linux, always run common redist without prompting
      if (hasCommonRedist && forType !== 'update' && process.platform !== 'linux') {
        addedInput = true;
        inputAsk = inputAsk.addBooleanOption(option => 
          option.setName('runCommonRedist')
            .setDisplayName('Run Common Redistributables')
            .setDescription('Run the Common Redistributables (Useful if you are downloading a game from Steamrip for the first time, or if you don\'t know if you need it).')
            .setDefaultValue(true)
        );
      }
      if (!autoFoundGameFolder) {
        addedInput = true;
        inputAsk = inputAsk.addStringOption(option => 
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
          inputAsk = inputAsk.addStringOption(option => 
            option.setName('executable')
              .setDisplayName('Executable Path')
              .setDescription('Executable path to run the game (ends in .exe). This will be inside of the game folder.')
              .setAllowedValues(executables.map(executable => relative(path, executable)))
              .setInputType('text')
              .setDefaultValue(relative(path, executables[0]))
          );
        }
        else {
          inputAsk = inputAsk.addStringOption(option => 
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

      // if the 'run common redist' is true (or on Linux, always run when available), we need to run the common redistributables
      let commonRedistExecutables: { name: string, path: string }[] = [];
      if (input.runCommonRedist || (process.platform === 'linux')) {
        commonRedistExecutables.push(
          { name: 'dotnet48', path: 'winetricks' },
          { name: 'vcrun2019', path: 'winetricks' },
          { name: 'vcrun2015', path: 'winetricks' },
          { name: 'xna40', path: 'winetricks' }
        )
      }
      if (autoFoundGameFolder) {
        input.cwd = path;
      }

      if (executables.length >= 0 && executables.length !== 1 && !String(input.executable).startsWith(path)) {
        // match the input.executable to an actual path
        input.executable = join(path, input.executable as string);
      }

      if (executables.length === 1) {
        input.executable = executables[0];
      }

      // if this is unity and we're on linux, remove all dependencies since it works out of the box (and i've been testing for like 10+ hours and it just won't work otherwise)
      // if (isUnity && process.platform === 'linux') {
      //   commonRedistExecutables = [];
      // }

      // then remove the download path
      yield* Effect.tryPromise({
        try: async () => await fs.rm(join(path, file.name), { maxRetries: 3, retryDelay: 1000 }),
        catch: () => {
          console.log('Failed to auto remove download path', join(path, file.name));
          return Effect.succeed(undefined);
        }
      });

      let winedlls: string[] = [];
      // Get all dll files in the folder and use those
      const dllFiles = (yield* Effect.tryPromise({
        try: async () => await fs.readdir(input.cwd as string),
        catch: () => []
      })) as string[];

      winedlls = dllFiles
        .filter(file => file.toLowerCase().endsWith('.dll'))
        .map(file => file.replace(/\.dll$/i, ''));



      console.log("Found dlls", winedlls);


      // write to the game install cwd a "steamrip-info.json"

      const { title }: { title: string | undefined } = yield* (manifest ? pipe(
        Effect.tryPromise(async () => await axios.get(manifest.url as string, { headers: scraper.getHeaderObject()})),
        Effect.andThen(response => new JSDOM(response.data)),
        Effect.andThen(dom => ({ title: dom.window.document.querySelector('.post-title')?.textContent?.trim() })),
        Effect.catchAll(error => {
          console.error('Failed to get app details', manifest?.url, error);
          return Effect.succeed({ title: undefined });
        })
      ) : Effect.succeed({ title: undefined }));

      yield* Effect.tryPromise({
        try: async () => await fs.writeFile(join(input.cwd as string, 'steamrip-info.json'), JSON.stringify({
          title: title ?? 'unknown',
        }, null, 2)),
        catch: () => {
          console.log('Failed to write steamrip-info.json', join(input.cwd as string, 'steamrip-info.json'));
          return Effect.succeed(undefined);
        }
      });

      const response: Parameters<typeof event.resolve>[0] = {
        cwd: input.cwd as string,
        launchExecutable: input.executable as string,
        version: latestVersion,
        redistributables: commonRedistExecutables,
        launchArguments: '%command%',
        umu: {
          umuId: `steam:${appID}`,
          dllOverrides: winedlls.map(dll => dll + '=n,b'),
          protonVersion: 'UMU-Latest'
        }
      };

      const finalResponse = applySetupOverrides(appID, response, {
        appID,
        platform: process.platform,
        installPath: input.cwd as string,
        executablePath: input.executable as string,
        dllOverrides: winedlls.map(dll => dll + '=n,b'),
      });
      console.log("Response", finalResponse);
      return yield* Effect.succeed(finalResponse);
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
