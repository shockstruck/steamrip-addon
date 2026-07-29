import {
  createCdpSessionSafe,
  DLService,
  PUPPETEER_OPTIONS,
  launchStandardBrowser,
} from "./BaseService";
import { Effect, pipe } from "effect";
import { BuzzHeavierError, DownloadCatcherError } from "../errors";
import type { EventResponse, SearchResult } from "ogi-addon";
import type { Browser, Page } from "puppeteer";

const STEAMRIP_REFERRER = "https://steamrip.com/";

export function getBzzhrNavigationOptions(): Parameters<Page["goto"]>[1] {
  return {
    // Bzzhr redirects referrer-less file-page requests back to SteamRIP.
    referer: STEAMRIP_REFERRER,
    waitUntil: "domcontentloaded",
  };
}

export default class BzzhrService extends DLService {
  public constructor() {
    super("BZZHR", 8); // Prefer Gofile, but rank Bzzhr above lower-priority fallbacks.
  }

  scrapeDownloadLinks(
    url: string,
    event: EventResponse<SearchResult>
  ): Effect.Effect<
    { name: string; url: string; headers: Record<string, string> }[],
    BuzzHeavierError | DownloadCatcherError
  > {
    const acquireConn = Effect.tryPromise({
      try: async () => {
        const { browser, page } = await launchStandardBrowser({
          headless: true,
        });
        return { browser, page } as { browser: Browser; page: Page };
      },
      catch: (error) => {
        console.error("[Bzzhr] Error launching browser:", error);
        return new BuzzHeavierError({ url, error });
      },
    });

    return Effect.acquireUseRelease(
      acquireConn,
      ({ browser, page }) =>
        Effect.gen(
          function* (this: BzzhrService) {
            yield* Effect.tryPromise({
              try: () => page.goto(url, getBzzhrNavigationOptions()),
              catch: (error) => new BuzzHeavierError({ url, error }),
            });

            yield* Effect.tryPromise({
              try: () =>
                page.evaluate(() => {
                  (window as any).adLink = null;
                }),
              catch: (error) => new BuzzHeavierError({ url, error }),
            });

            yield* Effect.tryPromise({
              try: () => page.waitForSelector(".link-button.gay-button"),
              catch: (error) => new BuzzHeavierError({ url, error }),
            });

            let downloadUrl: string | undefined;
            let lastError: unknown = undefined;
            let downloadButton:
              | Awaited<ReturnType<typeof page.$$>>[number]
              | undefined;

            // Helper to find the download button
            const findDownloadButton = () =>
              Effect.tryPromise({
                try: async () => {
                  const buttons = await page.$$(".gay-button");
                  for (const button of buttons) {
                    const hxGet = await button.evaluate((el) =>
                      el.getAttribute("hx-get")
                    );
                    if (hxGet?.includes("download")) {
                      return button;
                    }
                  }
                  return undefined;
                },
                catch: (error) => new BuzzHeavierError({ url, error }),
              });

            // wait until the network is idle
            yield* Effect.tryPromise({
              try: () => page.waitForNetworkIdle(),
              catch: (error) => new BuzzHeavierError({ url, error }),
            });

            // Keep reference to main page for focus management
            const mainPage = page;

            for (let attempt = 0; attempt < 5; attempt++) {
              // Ensure focus is on main page
              yield* Effect.tryPromise({
                try: () => mainPage.bringToFront(),
                catch: (error) => new BuzzHeavierError({ url, error }),
              });

              // Always re-find the download button in case the DOM changed
              downloadButton = yield* findDownloadButton();
              console.log('download button found:', downloadButton ? 'yes' : 'no');

              if (!downloadButton) {
                lastError = "No download button found";
                // Try to refresh and wait for the selector again
                yield* Effect.tryPromise({
                  try: () => page.reload({ waitUntil: "domcontentloaded" }),
                  catch: (error) => new BuzzHeavierError({ url, error }),
                });
                yield* Effect.tryPromise({
                  try: () => page.waitForSelector(".link-button.gay-button"),
                  catch: (error) => new BuzzHeavierError({ url, error }),
                });
                yield* Effect.tryPromise({
                  try: () => page.waitForNetworkIdle(),
                  catch: (error) => new BuzzHeavierError({ url, error }),
                });
                continue;
              }

              // press it once to activate the download (then an ad tab may open)
              yield* Effect.tryPromise({
                try: () => downloadButton!.click({ delay: 1000 }),
                catch: (error) => new BuzzHeavierError({ url, error }),
              });

              // Wait for ad tabs to fully initialize, then close them and refocus
              yield* Effect.sleep(3000);
              yield* Effect.tryPromise({
                try: async () => {
                  const pages = await browser.pages();
                  for (const p of pages) {
                    if (p !== mainPage) {
                      try {
                        await p.close();
                      } catch {}
                    }
                  }
                  await mainPage.bringToFront();
                },
                catch: (error) => new BuzzHeavierError({ url, error }),
              });

              // then re-find the download button and press it again to start the download
              downloadButton = yield* findDownloadButton();
              if (!downloadButton) {
                lastError = "No download button found after closing tabs";
                yield* Effect.tryPromise({
                  try: () => page.reload({ waitUntil: "domcontentloaded" }),
                  catch: (error) => new BuzzHeavierError({ url, error }),
                });
                yield* Effect.tryPromise({
                  try: () => page.waitForSelector(".link-button.gay-button"),
                  catch: (error) => new BuzzHeavierError({ url, error }),
                });
                yield* Effect.tryPromise({
                  try: () => page.waitForNetworkIdle(),
                  catch: (error) => new BuzzHeavierError({ url, error }),
                });
                continue;
              }

              console.log('starting to download...')
              downloadUrl = yield* pipe(
                this.downloadCatcher(mainPage, downloadButton!),
                Effect.catchAll((error) => {
                  console.error("[BuzzHeavier] Error downloading:", error);
                  return Effect.succeed(undefined);
                })
              );
              if (downloadUrl) break;

              // reload the page
              console.log('retry (' + attempt + ')');
              yield* Effect.tryPromise({
                try: () => page.reload({ waitUntil: "domcontentloaded" }),
                catch: (error) => new BuzzHeavierError({ url, error }),
              });
              yield* Effect.tryPromise({
                try: () => page.waitForSelector(".link-button.gay-button"),
                catch: (error) => new BuzzHeavierError({ url, error }),
              });
              yield* Effect.tryPromise({
                try: () => page.waitForNetworkIdle(),
                catch: (error) => new BuzzHeavierError({ url, error }),
              });
              continue;
            }
            if (!downloadUrl) {
              return yield* Effect.fail(
                new BuzzHeavierError({
                  url,
                  error: lastError ?? "No download url found",
                })
              );
            }

            // Get the headers from the page context using CDP
            const headers: Record<string, string> = yield* Effect.tryPromise({
              try: async () => {
                const client = await createCdpSessionSafe(mainPage as any);
                await client.send("Network.enable");
                let foundHeaders: Record<string, string> = {};
                // Listen for responseReceived events
                const handler = (params: any) => {
                  if (params.response && params.response.url === downloadUrl) {
                    foundHeaders = params.response.headers || {};
                  }
                };
                client.on("Network.responseReceived", handler);

                // Try to trigger a HEAD request to the downloadUrl to get headers
                try {
                  await mainPage.evaluate((url) => {
                    return fetch(url, {
                      method: "HEAD",
                      credentials: "include",
                    });
                  }, downloadUrl);
                } catch {
                  // ignore
                }

                // Wait a short time for the event to fire
                await new Promise((resolve) => setTimeout(resolve, 1000));
                client.off?.("Network.responseReceived", handler);
                await client.detach?.();
                return foundHeaders;
              },
              catch: (error) => new BuzzHeavierError({ url, error }),
            });

            return [
              {
                url: downloadUrl,
                name: "BUZZHEAVIER",
                headers: {
                  ...headers,
                  "OGI-Parallel-Limit": "1",
                },
              },
            ];
          }.bind(this)
        ),
      ({ browser }) => Effect.promise(() => browser.close())
    );
  }
}
