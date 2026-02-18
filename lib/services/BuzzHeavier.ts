import {
  DLService,
  PUPPETEER_OPTIONS,
  launchStandardBrowser,
} from "./BaseService";
import { Effect, pipe } from "effect";
import { BuzzHeavierError, DownloadCatcherError } from "../errors";
import type { EventResponse, SearchResult } from "ogi-addon";
import type { Browser, Page } from "puppeteer";

export default class BuzzheavierService extends DLService {
  public constructor() {
    super("Buzzheavier", 8); // Buzzheavier is super weird with downloads at times, so low priority.
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
          args: PUPPETEER_OPTIONS.args,
        });
        return { browser, page } as { browser: Browser; page: Page };
      },
      catch: (error) => {
        console.error("[BuzzHeavier] Error launching browser:", error);
        return new BuzzHeavierError({ url, error });
      },
    });

    return Effect.acquireUseRelease(
      acquireConn,
      ({ browser, page }) =>
        Effect.gen(
          function* (this: BuzzheavierService) {
            yield* Effect.tryPromise({
              try: () => page.goto(url),
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

            for (let attempt = 0; attempt < 5; attempt++) {
              // Always re-find the download button in case the DOM changed
              downloadButton = yield* findDownloadButton();

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
                continue;
              }

              // press it once to activate the download (then an ad pops up)
              yield* Effect.tryPromise({
                try: () => downloadButton!.click({ delay: 1000 }),
                catch: (error) => new BuzzHeavierError({ url, error }),
              });

              yield* Effect.sleep(6000);
              console.log('closing tabs...');
              // then close all tabs not the buzzheavier one
              yield* Effect.tryPromise({
                try: async () => {
                  const pages = await browser.pages();
                  const pagesToClose = [];
                  for (const p of pages) {
                    try {
                      if (p.url() !== url) {
                        pagesToClose.push(p);
                      }
                    } catch {
                      // Page already closed, skip
                    }
                  }
                  await Promise.all(
                    pagesToClose.map(async (p) => {
                      try {
                        await p.close();
                      } catch {
                        // Already closed, ignore
                      }
                    })
                  );
                },
                catch: (error) => { console.error("[BuzzHeavier] Error closing tabs:", error); return new BuzzHeavierError({ url, error }); },
              });
              yield* Effect.sleep(1000);

              // then re-find the download button and press it again to start the download
              downloadButton = yield* findDownloadButton();
              if (!downloadButton) {
                lastError = "No download button found";
                continue;
              }

              console.log('starting to download...')
              downloadUrl = yield* pipe(
                this.downloadCatcher(page, downloadButton!),
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
                const client = await page.target().createCDPSession();
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
                  await page.evaluate((url) => {
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
                client.off("Network.responseReceived", handler);
                await client.detach();
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
