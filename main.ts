import { JSDOM } from "jsdom";
import OGIAddon, {
  ConfigurationBuilder,
  EventResponse,
  SearchTool,
  type SetupEventResponse,
  type SearchResult,
} from "ogi-addon";
import Scraper from "./lib/scraper";
import {
  rankDownloadLinks,
  resolveServiceFromUrl,
  stringSimilarity,
  type DownloadLink,
} from "./lib/services/matcher";
import FileCryptService from "./lib/services/FileCrypt";
import { Context, Effect, Layer, Match, pipe } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import {
  CommonRedistError,
  FileCryptError,
  InputError,
  NoDownloadFoundError,
  NoFileFoundError,
  NoGameFoundError,
  NoServiceFoundError,
  NotOnlineError,
  RarExtractionError,
  ScrapeGameDownloadsError,
  SteamSearchError,
} from "./lib/errors";
import { dirname, join, relative } from "path";
import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import { existsSync, type Stats } from "fs";
import axios from "axios";
import { Stream } from "stream";
import { cloudflareSolve } from "./lib/cloudflare";
import { headerManager } from "./lib/header-manager";
import { fetchSteamripHtml } from "./lib/steamrip-fetch";
import {
  connectRealBrowser,
  PUPPETEER_OPTIONS,
  withSteamripReferer,
} from "./lib/services/BaseService";
import { applySetupOverrides } from "./lib/app-overrides";
import { extractRar, extractWith7Zip } from "./lib/archive";

const baseAddon = new OGIAddon({
  name: "Steamrip Tool",
  version: "1.0.0",
  id: "steamrip-addon",
  author: "fat-addons",
  description: "An addon to scrape steamrip and provide direct download links.",
  repository: "https://gitlab.com/fat-addons/steamrip-addon",
  storefronts: ["steam"],
});

export class AddonService extends Context.Tag("AddonService")<
  AddonService,
  {
    addon: OGIAddon;
    stringSimilarity: (a: string, b: string) => number;
  }
>() {}

const addonService = Layer.succeed(AddonService, {
  addon: baseAddon,
  stringSimilarity,
});

const program = Effect.gen(function* () {
  const scraper = new Scraper();
  const search = new SearchTool<{ name: string; url: string }>([], ["name"]);

  const { addon, stringSimilarity } = yield* AddonService;

  addon.on("configure", (config) =>
    config
      .addBooleanOption((option) =>
        option
          .setName("manualSelect")
          .setDisplayName("Service Selection")
          .setDescription(
            "Manually select the service you want to use for downloading games. Useful for services who rate limit or have download limits.",
          )
          .setDefaultValue(false),
      )
      .addBooleanOption((option) =>
        option
          .setName("disallowCaptchaBased")
          .setDisplayName("Disallow Captcha Based Services")
          .setDescription(
            "Disallow services that require a captcha to be solved.",
          )
          .setDefaultValue(false),
      )
      .addActionOption((option) =>
        option
          .setName("clearCloudflareCookies")
          .setDisplayName("Clear Cloudflare Cookies")
          .setDescription("Clear the Cloudflare cookies from the browser.")
          .setTaskName("clearCloudflareCookies")
          .setButtonText("Clear"),
      )
      .addActionOption((option) =>
        option
          .setName("clearDownloadCache")
          .setDisplayName("Clear Steamrip Cache")
          .setDescription("Clear the Steamrip cache from the device.")
          .setTaskName("clearDownloadCache")
          .setButtonText("Clear"),
      ),
  );

  addon.onTask("clearCloudflareCookies", (task) =>
    Effect.gen(function* () {
      yield* headerManager.clearHeaders();
      yield* Effect.sync(() => task.log("Cloudflare cookies cleared."));
      yield* Effect.sync(() => task.complete());
    }).pipe(Effect.runPromise),
  );
  addon.onTask("clearDownloadCache", (task) =>
    Effect.gen(function* () {
      yield* scraper.cleanupAllScrapes();
      yield* Effect.sync(() => task.log("Steamrip cache cleared."));
      yield* Effect.sync(() => task.complete());
    }).pipe(Effect.runPromise),
  );

  const refreshSteamripCatalog = Effect.fn("refreshSteamripCatalog")(function* (
    force: boolean = false,
  ) {
    yield* headerManager.loadHeaders();
    yield* pipe(
      cloudflareSolve("https://steamrip.com", addon),
      Effect.catchAll((error) => {
        console.error("Background Cloudflare solve failed:", error);
        return Effect.succeed(undefined);
      }),
    );

    yield* scraper.cleanupExpiredScrapes();
    yield* scraper.upgradeLocals(force);
    yield* scraper.processLocals();
    yield* Effect.sync(() => search.addItems(scraper.catalog.games));
  });

  addon.on("connect", (event) => {
    const connectEffect = Effect.fn("connectEffect")(function* () {
      const task = yield* Effect.tryPromise({
        try: () => addon.task(),
        catch: () => new Error("Failed to create task"), // Define a specific error if needed
      });

      // check if the system is online first, and if not, then abort mission!
      console.log("Checking online...");
      yield* Effect.tryPromise({
        try: async () =>
          axios({
            url: "https://google.com",
            timeout: 5000,
          }),
        catch: () => new NotOnlineError(),
      }).pipe(
        Effect.catchTag("NotOnlineError", (_) => {
          addon.notify({
            id: String(Math.floor(Math.random() * 10000)),
            message:
              "Steamrip Addon: Cannot access network check, stopping addon.",
            type: "error",
          });

          return Effect.dieMessage("Cannot access network check");
        }),
      );
      process.env.PUPPETEER_PROTOCOL_TIMEOUT = String(
        PUPPETEER_OPTIONS.protocolTimeout || 180000,
      );

      yield* Effect.sync(() => task.log("Checking browser availability..."));
      const chromeInstalled = yield* Effect.tryPromise(() =>
        connectRealBrowser({ headless: true, disableXvfb: true }),
      ).pipe(
        Effect.catchAll((err) => {
          console.log("Browser check failed:", err);
          return Effect.succeed(undefined);
        }),
      );

      if (!chromeInstalled) {
        const browserInstallHelp =
          process.platform === "linux"
            ? "Install Chromium from the system Flathub source in Discover or run: flatpak install --system flathub org.chromium.Chromium. Then restart the addon server."
            : "Install Chrome from the official website, then restart the addon server.";

        yield* Effect.sync(() =>
          task.log(
            `Steamrip could not start Chrome/Chromium. ${browserInstallHelp}`,
          ),
        );
        yield* Effect.sync(() =>
          addon.notify({
            message: `Steamrip could not start Chrome/Chromium. ${browserInstallHelp}`,
            id: "str-browser-unavailable",
            type: "error",
          }),
        );

        yield* Effect.promise(async () =>
          event.askForInput(
            "(1/3) Chrome/Chromium could not be started",
            "Steamrip requires Chrome/Chromium to access Steamrip.com.",
            new ConfigurationBuilder(),
          ),
        );

        if (process.platform === "linux") {
          yield* Effect.promise(async () =>
            event.askForInput(
              "(2/3) Install Chromium from system Flathub",
              "In Discover, select the system Flathub source for Chromium, or run: flatpak install --system flathub org.chromium.Chromium",
              new ConfigurationBuilder(),
            ),
          );
        } else {
          yield* Effect.promise(async () =>
            event.askForInput(
              "(2/3) Install Chrome",
              "Download Chrome from the official website and install it.",
              new ConfigurationBuilder(),
            ),
          );
        }

        yield* Effect.promise(async () =>
          event.askForInput(
            "(3/3) Restart the addon server",
            "After installing Chrome/Chromium, restart the addon server and try again.",
            new ConfigurationBuilder(),
          ),
        );

        yield* Effect.sync(() => task.complete());
        return;
      }

      yield* Effect.sync(() => task.log("Chrome is installed on the device."));
      yield* Effect.promise(async () => chromeInstalled.browser.close());

      yield* Effect.sync(() => task.log("Loading cached Steamrip catalog..."));
      const loadedCachedCatalog = yield* scraper.processLocalsIfPresent();
      if (loadedCachedCatalog) {
        yield* Effect.sync(() => search.addItems(scraper.catalog.games));
        yield* Effect.sync(() =>
          task.log(
            `Loaded ${scraper.catalog.games.length} cached Steamrip games.`,
          ),
        );
      } else {
        yield* Effect.sync(() =>
          task.log(
            "No cached Steamrip catalog found; first search may take longer.",
          ),
        );
      }

      const stats = yield* scraper.getScrapeStats();
      yield* Effect.sync(() =>
        task.log(
          `Scrape cache: ${stats.valid} valid, ${stats.expired} expired, ${stats.total} total files`,
        ),
      );

      yield* Effect.sync(() =>
        task.log("Starting Steamrip catalog refresh in the background..."),
      );
      yield* Effect.sync(() => {
        pipe(
          refreshSteamripCatalog(scraper.catalog.games.length === 0),
          Effect.tap(() =>
            Effect.sync(() =>
              addon.notify({
                message: "Steamrip catalog refreshed.",
                id: "steamrip-catalog-refreshed",
                type: "success",
              }),
            ),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.error(
                "Background Steamrip catalog refresh failed:",
                error,
              );
              addon.notify({
                message:
                  "Steamrip catalog refresh failed. Searches will use cached data if available.",
                id: "steamrip-catalog-refresh-failed",
                type: "warning",
              });
            }),
          ),
          Effect.runFork,
        );
      });

      yield* Effect.sync(() => task.complete());
    });

    Effect.runPromise(connectEffect()).catch((error) => {
      console.error("Error during connect:", error);
      // Show user-friendly error message for Cloudflare failures
      if (
        error.message &&
        (error.message.includes("Cloudflare") ||
          error.message.includes("cf_") ||
          error.message.includes("No valid Cloudflare headers"))
      ) {
        addon.notify({
          message:
            "Failed to solve Cloudflare protection. Please try again or check your internet connection.",
          id: "cloudflare-error",
          type: "error",
        });
      }
    });
  });

  addon.on("search", (info, event) => {
    const { for: forType } = info;
    if (forType === "task") {
      event.resolve([]);
      return;
    }

    const { storefront, appID } = info;
    event.defer();

    const searchEffect = Effect.fn("searchEffect")(function* () {
      const steamResult = yield* Effect.tryPromise({
        try: async () => await addon.getAppDetails(appID, "steam"),
        catch: () => new SteamSearchError({ query: String(appID) }),
      });

      if (!steamResult) {
        return yield* Effect.fail(
          new SteamSearchError({ query: String(appID) }),
        );
      }

      if (scraper.catalog.games.length === 0) {
        console.log("Steamrip catalog is empty, refreshing before search...");
        yield* refreshSteamripCatalog(true);
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
      const SIMILARITY_THRESHOLD = 0.6;
      console.log("Best score", bestScore);
      const game = bestScore >= SIMILARITY_THRESHOLD ? bestMatch : undefined;

      if (!game) {
        console.log("No game found");
        return yield* Effect.fail(
          new NoGameFoundError({ query: String(appID) }),
        );
      }

      console.log("Found game", game.name);

      // if this is an update, we need to check if the game has already been downloaded
      if (forType === "update") {
        const { cwd } = info.libraryInfo;
        const steamripInfo = yield* Effect.tryPromise(
          async () =>
            await fs.readFile(
              join(cwd as string, "steamrip-info.json"),
              "utf8",
            ),
        ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
        if (steamripInfo) {
          const { title } = JSON.parse(steamripInfo);
          if (title === game.name) {
            console.log("Game already downloaded.", game.name);
            return [
              {
                name: "You have the latest version Steamrip has for this game.",
                downloadType: "empty",
              } as SearchResult,
            ];
          }
        }
      }
      const resolutions = [
        {
          name: game.name,
          downloadType: "request",
          manifest: {
            url: game.url,
          },
        },
      ] as SearchResult[];

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
        },
      }),
      Effect.catchAll((error: unknown) => {
        console.error("Search error:", error);
        if (
          error instanceof Error &&
          error.message &&
          error.message.includes("No valid Cloudflare headers")
        ) {
          addon.notify({
            message:
              "Cloudflare headers are missing. Please reconnect to solve Cloudflare protection.",
            id: "cloudflare-headers-missing",
            type: "warning",
          });
        }
        return Effect.succeed([]);
      }),
      Effect.andThen((res) => event.resolve(res)),
      Effect.runFork,
    );
  });

  addon.on("request-dl", (appID, info, event) => {
    const searchEvent = event as EventResponse<SearchResult>;
    searchEvent.defer();

    const getDownloadLinks = Effect.try({
      try: () => {
        const url = info.manifest?.url;
        if (typeof url !== "string" || !url)
          throw new NoGameFoundError({ query: String(appID) });
        return scraper.scrapeGameDownloads(url);
      },
      catch: (e) =>
        e instanceof NoGameFoundError
          ? e
          : new ScrapeGameDownloadsError({ game: String(appID) }),
    });

    const findWorkingService = Effect.fn("findWorkingService")(function* (
      links: DownloadLink[],
      event: EventResponse<SearchResult>,
    ) {
      const ranked = yield* pipe(
        Effect.succeed(links),
        Effect.andThen((links) => {
          if (addon.config.getBooleanValue("manualSelect") ?? false) {
            return Effect.promise(async () => {
              const resolved = await Effect.runPromise(
                Effect.forEach(links, (link) =>
                  resolveServiceFromUrl(link.url).pipe(
                    Effect.map((service) => ({ service, url: link.url })),
                  ),
                ),
              );
              const config = new ConfigurationBuilder().addStringOption(
                (option) =>
                  option
                    .setName("service")
                    .setDisplayName("Service")
                    .setDescription(
                      "Please select the service you want to use for downloading this game.",
                    )
                    .setAllowedValues(
                      resolved.map(({ service }) => service.name),
                    ),
              );
              const input = await event.askForInput(
                "Manual Service Selection",
                "Please select the service you want to use for downloading this game.",
                config,
              );
              const selected = resolved.find(
                ({ service }) => service.name === input.service,
              );
              return selected ? [{ url: selected.url }] : links;
            });
          }
          return Effect.succeed(links);
        }),
        Effect.andThen(rankDownloadLinks),
      );

      return yield* Effect.gen(function* () {
        let lastError: unknown = null;
        for (const { service, url } of ranked) {
          try {
            console.log(`Trying service: ${service.name}`);
            let currentService = service;
            if (
              currentService.isCaptchaBased() &&
              addon.config.getBooleanValue("disallowCaptchaBased")
            ) {
              console.log(
                "Skipping captcha based service",
                currentService.name,
              );
              continue;
            }

            let currentUrl = url;

            if (currentService instanceof FileCryptService) {
              const fcResult = yield* pipe(
                currentService.scrapeDownloadLinks(currentUrl, event),
                Effect.catchAll(() => Effect.succeed([])),
              );
              if (fcResult.length === 0 || !fcResult[0].url) {
                continue;
              }
              currentService = yield* resolveServiceFromUrl(fcResult[0].url);
              if (currentService.priority === 0) {
                continue;
              }
              currentUrl = fcResult[0].url;
            }

            const downloadUrls = yield* pipe(
              currentService.scrapeDownloadLinks(currentUrl, event),
              Effect.catchAll((e) => {
                console.error("Error", e);
                return Effect.succeed([]);
              }),
            );
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
              continue;
            }
            if (downloadUrls.length === 0) {
              continue;
            }
            // Found a working service, break out
            return {
              url: downloadUrls[0].url,
              name: downloadUrls[0].name,
              headers: withSteamripReferer(downloadUrls[0].headers),
            };
          } catch (err) {
            lastError = err;
            // Continue to next service
          }
        }
        // If none worked, fail with the last error or a generic one
        addon.notify({
          id: "no-download-found-steamrip",
          message: "No download supported found for " + info.name,
          type: "error",
        });
        yield* Effect.promise(
          async () =>
            await event.askForInput(
              "No download link supported",
              "You are seeing this message because there was an issue with downloading the game through one of the services. Please try again, and if you still can't download it, please report the issue to the thread.",
              new ConfigurationBuilder(),
            ),
        );
        return yield* Effect.fail(lastError ?? new NoDownloadFoundError());
      });
    });

    const requestDlEffect = Effect.fn("requestDlEffect")(function* () {
      const links = yield* getDownloadLinks;

      const downloadDetails = yield* findWorkingService(
        yield* links,
        searchEvent,
      );

      return {
        downloadType: "direct",
        name: info.name,
        files: [
          {
            name: downloadDetails.name,
            downloadURL: downloadDetails.url,
            headers: downloadDetails.headers,
          },
        ],
        manifest: info.manifest,
      } as SearchResult;
    });

    pipe(
      requestDlEffect(),
      Effect.catchAll((error: unknown) => {
        console.error("Error in request-dl:", error);
        if (
          error instanceof Error &&
          error.message &&
          error.message.includes("No valid Cloudflare headers")
        ) {
          addon.notify({
            message:
              "Cloudflare headers are missing. Please reconnect to solve Cloudflare protection.",
            id: "cloudflare-headers-missing",
            type: "warning",
          });
        }
        searchEvent.fail("Failed to get download link");
        return Effect.fail(error);
      }),
      Effect.andThen((res) => searchEvent.resolve(res)),
      Effect.runFork,
    );
  });

  addon.on(
    "setup",
    ({ path, type, multiPartFiles, appID, manifest, for: forType }, event) => {
      if (type === "empty") {
        event.fail("Game already downloaded.");
        return;
      }
      event.log(`Setup: path: ${path}, multiPartFiles: ${multiPartFiles}`);
      event.defer();
      const setupEffect = Effect.fn("setupEffect")(function* () {
        const programFiles7zip = join(
          process.env["ProgramFiles"] || "C:\\Program Files",
          "7-Zip",
          "7z.exe",
        );
        const file = multiPartFiles?.[0];
        if (!file) return yield* Effect.fail(new NoFileFoundError());

        const showErrorScreen = async (details?: string) => {
          await event.askForInput(
            "Archive extraction failed",
            "The download may be incomplete, or the installed RAR extractor may not support this archive." +
              (details ? ` Extractor details: ${details}` : "") +
              " Go to the path: \"" +
              path +
              '" and delete the archive before trying the download again.',
            new ConfigurationBuilder(),
          );
        };

        event.log("Waiting for zip to be unlocked by OpenGameInstaller...");
        yield* Effect.sleep(1000);

        // now, inferring that it's a rar file, we need to extract it to the "path" folder
        // use 7zip in the program files if this is a windows machine

        // if there are other files in this path other than the input archive, we need to delete them
        const files = yield* Effect.tryPromise({
          try: async () => await fs.readdir(path),
          catch: () => [],
        });
        if (files.length > 1) {
          event.log("Found other files in the path, deleting them...");
          for (const fileName of files) {
            if (fileName !== file.name) {
              const result = yield* pipe(
                Effect.tryPromise({
                  try: async () => {
                    await fs.rm(join(path, fileName), {
                      force: true,
                      recursive: true,
                      maxRetries: 3,
                      retryDelay: 1000,
                    });
                    return true;
                  },
                  catch: () => {
                    console.error("Error deleting file", fileName);
                    return false;
                  },
                }),
                Effect.catchAll((e) => {
                  console.error("Error deleting file", fileName);
                  return Effect.succeed(false);
                }),
              );
            }
          }
        }
        event.log("Extracting archive (this may take a while)...");
        event.progress = 0;
        if (
          process.platform === "win32" ||
          process.platform === "darwin" ||
          process.platform === "linux"
        ) {
          const archivePath = join(path, file.name);
          const result = yield* Effect.tryPromise({
            try: () =>
              process.platform === "win32"
                ? extractWith7Zip(
                    archivePath,
                    path,
                    programFiles7zip,
                    (progress: number) => {
                      event.progress = progress;
                    },
                  )
                : extractRar(
                    archivePath,
                    path,
                    "unrar",
                    (progress: number) => {
                      event.progress = progress;
                    },
                  ),
            catch: (error) => ({
              error: error as Error,
              status: 1,
              output: "",
            }),
          });
          if (result.error) {
            console.error("Error extracting archive", result);
            console.error("Error extracting archive", result.error);
            yield* Effect.promise(async () =>
              showErrorScreen(result.error?.message),
            );
            return yield* Effect.fail(
              new RarExtractionError({ path, error: result.error.message }),
            );
          }
          if (result.status !== 0) {
            console.error("Error extracting archive", result.status);
            console.error("Extractor output", result.output);
            const extractionError =
              result.output ||
              `Archive extraction failed with code ${result.status}`;
            yield* Effect.promise(async () =>
              showErrorScreen(extractionError.slice(-1000)),
            );
            return yield* Effect.fail(
              new RarExtractionError({
                path,
                error: extractionError,
              }),
            );
          }
        }

        // Get Steam App Details
        let appDetails = yield* Effect.tryPromise(
          async () => await addon.getAppDetails(appID, "steam"),
        ).pipe(Effect.catchAll((_) => Effect.succeed(undefined)));

        // Get Latest Version
        let latestVersion = (appDetails?.latestVersion ?? "1.0").trim();

        // now, if there is a _CommonRedist folder, we need to put a boolean
        const hasCommonRedist = yield* Effect.tryPromise({
          try: async () =>
            (await fs.stat(join(path, "_CommonRedist"))).isDirectory(),
          catch: () => false,
        });

        // now check: if there are at least 2 folders in the path, and one is the _CommonRedist folder and the other is the game folder
        const folders = yield* Effect.tryPromise({
          try: async () => await fs.readdir(path),
          catch: () => [],
        });
        let autoFoundGameFolder = yield* pipe(
          folders,
          Effect.forEach(
            (folder) =>
              Effect.tryPromise({
                try: async () =>
                  [folder, await fs.stat(join(path, folder))] as [
                    string,
                    Stats,
                  ],
                catch: () => undefined,
              }),
            { concurrency: "unbounded" },
          ),
          // filter to only folders
          Effect.map((folders) =>
            folders.filter((folder) => folder && folder[1].isDirectory()),
          ),
          // Now check if there are 2 folders, and one is the _CommonRedist folder and the other is the game folder
          Effect.map((folders) => {
            if (folders.length !== 2) return undefined;
            if (
              folders.some((folder) => folder[0] === "_CommonRedist") &&
              folders.some((folder) => folder[0] !== "_CommonRedist")
            ) {
              return folders.find(
                (folder) => folder[0] !== "_CommonRedist",
              )?.[0];
            }
            return undefined;
          }),
        );

        if (autoFoundGameFolder) {
          // move all the contents in that folder into the path
          yield* Effect.tryPromise({
            try: async () => {
              const contents = await fs.readdir(
                join(path, autoFoundGameFolder as string),
              );
              for (const content of contents) {
                await fs.rename(
                  join(path, autoFoundGameFolder as string, content),
                  join(path, content),
                );
              }
              await fs.rmdir(join(path, autoFoundGameFolder as string), {
                recursive: true,
              });
              return undefined;
            },
            catch: () => {
              console.log(
                "Failed to move folder",
                join(path, autoFoundGameFolder as string),
              );
              return Effect.succeed(undefined);
            },
          });
        }

        let executables: string[] = [];
        if (autoFoundGameFolder) {
          console.log(
            "Auto found game folder",
            autoFoundGameFolder,
            "Searching for executables...",
          );
          executables = yield* pipe(
            Effect.tryPromise({
              try: async () => await fs.readdir(path),
              catch: () => [],
            }),
            Effect.map((executables) =>
              executables.filter((executable) => executable.endsWith(".exe")),
            ),
            // remove UnityCrashHandler
            Effect.map((executables) =>
              executables.filter(
                (executable) =>
                  !executable.toLowerCase().includes("unitycrashhandler"),
              ),
            ),
            // remove uninstall00.exe
            Effect.map((executables) =>
              executables.filter(
                (executable) =>
                  !executable.toLowerCase().includes("unins000.exe"),
              ),
            ),
            Effect.map((executables) =>
              executables.map((executable) => join(path, executable)),
            ),
          );
          console.log("Found executables", executables);
          if (executables.length === 0) {
            event.log("No executables found in the game folder");
            autoFoundGameFolder = undefined;
          }
        }

        // Lossless Scaling Has Some Unique Properties
        if (appID === 993090 && process.platform === "linux") {
          // check if the executable is "LosslessScaling.exe"
          if (
            executables.some((executable) =>
              executable.toLowerCase().includes("losslessscaling.exe"),
            )
          ) {
            // move the entire directory of the cwd to path /home/{user}/.steam/steamapps/common/Lossless Scaling
            let newPath = join(
              "/home/",
              process.env.USER as string,
              ".steam/steamapps/common/Lossless Scaling",
            );
            yield* Effect.tryPromise({
              try: async () => await fs.rename(path, newPath),
              catch: () => {
                console.error("Error moving directory", newPath);
                return Effect.succeed(undefined);
              },
            });

            path = newPath;
            executables = executables.map((executable) =>
              executable.replace(path, newPath),
            );
            // then just resolve everything and return
            const losslessResponse: SetupEventResponse = {
              cwd: newPath,
              launchExecutable: executables[0],
              version: latestVersion,
              redistributables: [],
              launchArguments: "%command%",
              umu: {
                umuId: `steam:${appID}`,
                dllOverrides: [],
                protonVersion: "UMU-Proton",
              },
            };
            return yield* Effect.succeed(
              applySetupOverrides(appID, losslessResponse, {
                appID,
                platform: process.platform,
                installPath: newPath,
                executablePath: executables[0],
                dllOverrides: [],
              }),
            );
          }
        }

        // now it's time to build the ui for the setup
        let inputAsk = new ConfigurationBuilder();
        let addedInput = false;
        // On Linux, always run common redist without prompting
        if (
          hasCommonRedist &&
          forType !== "update" &&
          process.platform !== "linux"
        ) {
          addedInput = true;
          inputAsk = inputAsk.addBooleanOption((option) =>
            option
              .setName("runCommonRedist")
              .setDisplayName("Run Common Redistributables")
              .setDescription(
                "Run the Common Redistributables (Useful if you are downloading a game from Steamrip for the first time, or if you don't know if you need it).",
              )
              .setDefaultValue(true),
          );
        }
        if (!autoFoundGameFolder) {
          addedInput = true;
          inputAsk = inputAsk.addStringOption((option) =>
            option
              .setName("cwd")
              .setDisplayName("Game Folder")
              .setDescription(
                "Game folder to run the game from. This is the folder that contains the game executable.",
              )
              .setInputType("folder")
              .setDefaultValue(""),
          );
        }
        if (executables.length >= 0 && executables.length !== 1) {
          addedInput = true;
          if (executables.length > 1) {
            inputAsk = inputAsk.addStringOption((option) =>
              option
                .setName("executable")
                .setDisplayName("Executable Path")
                .setDescription(
                  "Executable path to run the game (ends in .exe). This will be inside of the game folder.",
                )
                .setAllowedValues(
                  executables.map((executable) => relative(path, executable)),
                )
                .setInputType("text")
                .setDefaultValue(relative(path, executables[0])),
            );
          } else {
            inputAsk = inputAsk.addStringOption((option) =>
              option
                .setName("executable")
                .setDisplayName("Executable Path")
                .setDescription(
                  "Executable path to run the game (ends in .exe). This will be inside of the game folder.",
                )
                .setInputType("file")
                .setDefaultValue(""),
            );
          }
        }
        let input: { [key: string]: string | boolean | number } = {};
        if (addedInput) {
          input = yield* Effect.tryPromise({
            try: async () =>
              await event.askForInput(
                "Setup your Game",
                "Setup your new game",
                inputAsk,
              ),
            catch: () =>
              Effect.fail(new InputError({ error: "Failed to ask for input" })),
          });
        }

        // if the 'run common redist' is true (or on Linux, always run when available), we need to run the common redistributables
        let commonRedistExecutables: { name: string; path: string }[] = [];
        if (input.runCommonRedist || process.platform === "linux") {
          commonRedistExecutables.push(
            { name: "dotnet40", path: "winetricks" },
            { name: "dotnet48", path: "winetricks" },
            { name: "vcrun2019", path: "winetricks" },
            { name: "vcrun2022", path: "winetricks" },
            { name: "xna40", path: "winetricks" },
          );
        }
        if (autoFoundGameFolder) {
          input.cwd = path;
        }

        if (
          executables.length >= 0 &&
          executables.length !== 1 &&
          !String(input.executable).startsWith(path)
        ) {
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
          try: async () =>
            await fs.rm(join(path, file.name), {
              maxRetries: 3,
              retryDelay: 1000,
            }),
          catch: () => {
            console.log(
              "Failed to auto remove download path",
              join(path, file.name),
            );
            return Effect.succeed(undefined);
          },
        });

        let winedlls: string[] = [];
        // Get all dll files in the folder and use those
        const dllFiles = (yield* Effect.tryPromise({
          try: async () => await fs.readdir(input.cwd as string),
          catch: () => [],
        })) as string[];

        winedlls = dllFiles
          .filter((file) => file.toLowerCase().endsWith(".dll"))
          .map((file) => file.replace(/\.dll$/i, ""));

        // write to the game install cwd a "steamrip-info.json"

        const { title }: { title: string | undefined } = yield* manifest
          ? pipe(
              fetchSteamripHtml(manifest.url as string),
              Effect.andThen((html) => new JSDOM(html)),
              Effect.andThen((dom) => ({
                title: dom.window.document
                  .querySelector(".post-title")
                  ?.textContent?.trim(),
              })),
              Effect.catchAll((error) => {
                console.error(
                  "Failed to get app details",
                  manifest?.url,
                  error,
                );
                return Effect.succeed({ title: undefined });
              }),
            )
          : Effect.succeed({ title: undefined });

        yield* Effect.tryPromise({
          try: async () =>
            await fs.writeFile(
              join(input.cwd as string, "steamrip-info.json"),
              JSON.stringify(
                {
                  title: title ?? "unknown",
                },
                null,
                2,
              ),
            ),
          catch: () => {
            console.log(
              "Failed to write steamrip-info.json",
              join(input.cwd as string, "steamrip-info.json"),
            );
            return Effect.succeed(undefined);
          },
        });

        const response: Parameters<typeof event.resolve>[0] = {
          cwd: input.cwd as string,
          launchExecutable: input.executable as string,
          version: latestVersion,
          redistributables: commonRedistExecutables,
          launchArguments: "%command%",
          umu: {
            umuId: `steam:${appID}`,
            dllOverrides: winedlls.map((dll) => dll + "=n,b"),
            protonVersion: "UMU-Proton",
          },
        };

        const finalResponse = applySetupOverrides(appID, response, {
          appID,
          platform: process.platform,
          installPath: input.cwd as string,
          executablePath: input.executable as string,
          dllOverrides: winedlls.map((dll) => dll + "=n,b"),
        });
        return yield* Effect.succeed(finalResponse);
      });

      pipe(
        setupEffect(),
        Effect.catchAll((error) => {
          console.error("Error setting up", error);
          event.fail("Failed to setup");
          return Effect.fail(error);
        }),
        Effect.andThen((res) => event.resolve(res)),
        Effect.runFork,
      );
    },
  );

  addon.on("disconnect", () => {
    process.exit(0);
  });
});

BunRuntime.runMain(pipe(program, Effect.provide(addonService)));
