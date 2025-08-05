import { DLService, PUPPETEER_OPTIONS } from "./BaseService";
import puppeteer from "puppeteer-extra";
import { type Browser, type ElementHandle } from "puppeteer";
import { Effect, pipe } from "effect";
import { BuzzHeavierError, DownloadCatcherError } from "../errors";
import type { EventResponse, SearchResult } from "ogi-addon";

export default class BuzzheavierService extends DLService {
  public constructor() {
    super('Buzzheavier', 4); // Buzzheavier is super weird with downloads at times, so low priority.
  }

  scrapeDownloadLinks(
    url: string,
    event: EventResponse<SearchResult>
  ): Effect.Effect<
    { name: string; url: string; headers: Record<string, string> }[],
    BuzzHeavierError | DownloadCatcherError
  > {
    const acquireBrowser = Effect.tryPromise({
      try: () => puppeteer.launch(PUPPETEER_OPTIONS),
      catch: (error) => new BuzzHeavierError({ url, error }),
    });

    return Effect.acquireUseRelease(
      acquireBrowser,
      (browser: Browser) =>
        Effect.gen(function* (this: BuzzheavierService) {
          const page = yield* Effect.tryPromise({
            try: () => browser.newPage(),
            catch: (error) => new BuzzHeavierError({ url, error }),
          });

          yield* Effect.tryPromise({
            try: () => page.goto(url),
            catch: (error) => new BuzzHeavierError({ url, error }),
          });

          yield* Effect.tryPromise({
            try: () => page.evaluate(() => {
              (window as any).adLink = null;
            }),
            catch: (error) => new BuzzHeavierError({ url, error }),
          });

          yield* Effect.tryPromise({
            try: () => page.waitForSelector('.link-button.gay-button'),
            catch: (error) => new BuzzHeavierError({ url, error }),
          });

          let downloadUrl: string | undefined;
          let lastError: unknown = undefined;
          let downloadButton: ElementHandle<Element> | undefined;

          // Helper to find the download button
          const findDownloadButton = () =>
            Effect.tryPromise({
              try: async () => {
                const buttons = await page.$$('.link-button.gay-button');
                for (const button of buttons) {
                  const hxGet = await button.evaluate((el) =>
                    el.getAttribute('hx-get')
                  );
                  if (hxGet?.includes('download')) {
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
              lastError = 'No download button found';
              // Try to refresh and wait for the selector again
              yield* Effect.tryPromise({
                try: () => page.reload({ waitUntil: 'domcontentloaded' }),
                catch: (error) => new BuzzHeavierError({ url, error }),
              });
              yield* Effect.tryPromise({
                try: () => page.waitForSelector('.link-button.gay-button'),
                catch: (error) => new BuzzHeavierError({ url, error }),
              });
              continue;
            }

            try {
              downloadUrl = yield* this.downloadCatcher(page, downloadButton);
              if (downloadUrl) break;
            } catch (err) {
              lastError = err;
            }

            // If not successful, refresh and wait for the page to load again
            yield* Effect.tryPromise({
              try: () => page.reload({ waitUntil: 'domcontentloaded' }),
              catch: (error) => new BuzzHeavierError({ url, error }),
            });
            yield* Effect.tryPromise({
              try: () => page.waitForSelector('.link-button.gay-button'),
              catch: (error) => new BuzzHeavierError({ url, error }),
            });
          }

          if (!downloadUrl) {
            return yield* Effect.fail(
              new BuzzHeavierError({
                url,
                error: lastError ?? 'No download url found',
              })
            );
          }

          // Get the headers from the page context using CDP
          const headers: Record<string, string> = yield* Effect.tryPromise({
            try: async () => {
              const client = await page.target().createCDPSession();
              await client.send('Network.enable');
              let foundHeaders: Record<string, string> = {};
              // Listen for responseReceived events
              const handler = (params: any) => {
                if (
                  params.response &&
                  params.response.url === downloadUrl
                ) {
                  foundHeaders = params.response.headers || {};
                }
              };
              client.on('Network.responseReceived', handler);

              // Try to trigger a HEAD request to the downloadUrl to get headers
              try {
                await page.evaluate((url) => {
                  return fetch(url, { method: 'HEAD', credentials: 'include' });
                }, downloadUrl);
              } catch {
                // ignore
              }

              // Wait a short time for the event to fire
              await new Promise((resolve) => setTimeout(resolve, 1000));
              client.off('Network.responseReceived', handler);
              await client.detach();
              return foundHeaders;
            },
            catch: (error) => new BuzzHeavierError({ url, error }),
          });

          return [
            {
              url: downloadUrl,
              name: 'BUZZHEAVIER',
              headers,
            },
          ];
        }.bind(this)),
      (browser) => Effect.promise(() => browser.close())
    );
  }
}