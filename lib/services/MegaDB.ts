import { createCdpSessionSafe, DLService, launchStandardBrowser, navigateBrowserPage } from "./BaseService";
import { Effect } from "effect";
import { MegaDBError, DownloadCatcherError } from "../errors";
import type { EventResponse, SearchResult } from "ogi-addon";
import { ConfigurationBuilder } from "ogi-addon";
import type { Browser, Page } from "puppeteer";

async function closePopupPages(browser: any, mainPage: any): Promise<void> {
  try {
    const pages: any[] = (await browser.pages?.()) ?? [];
    for (const p of pages) {
      if (p && p !== mainPage) {
        try {
          await p.close?.();
        } catch {}
      }
    }
    await mainPage.bringToFront?.();
  } catch {
    // ignore (browser/page may be closing)
  }
}

export default class MegaDBService extends DLService {
  public constructor() {
    super('MegaDB', 4);
  }

  isCaptchaBased(): boolean {
    return true; // Similar to FileCrypt, requires user interaction
  }

  scrapeDownloadLinks(
    url: string,
    event: EventResponse<SearchResult>
  ): Effect.Effect<
    { name: string; url: string; headers: Record<string, string> }[],
    MegaDBError | DownloadCatcherError
  > {
    
    const acquireConn = Effect.tryPromise({
      try: async () => {
        await event.askForInput(
          'MegaDB Download',
          'A browser window will open to MegaDB. Please solve any captchas and click the download button. Our system will detect the download and capture the URL automatically.',
          new ConfigurationBuilder()
        )
        const { browser, page } = await launchStandardBrowser({ 
          headless: false // Non-headless like FileCrypt for user interaction
        });
        return { browser, page } as { browser: Browser; page: Page };
      },
      catch: (error) => {
        console.error('Error acquiring connection', error);
        return new MegaDBError({ url, error });
      }
    });

    return Effect.acquireUseRelease( 
      acquireConn,
      ({ browser, page }) =>
        Effect.gen(function* (this: MegaDBService) {
          // Notify user about captcha/interaction requirement
          
          // Navigate to the URL
          let activePage: any = page;
          const popupHandler = async () => closePopupPages(browser as any, activePage);
          try {
            (browser as any).on?.("targetcreated", popupHandler);
          } catch {}

          activePage = yield* Effect.tryPromise({
            try: () => navigateBrowserPage(browser as any, page as any, url, { waitUntil: 'domcontentloaded' }),
            catch: (error) => new MegaDBError({ url, error }),
          });

          // Wait for the page to load completely
          yield* Effect.tryPromise({
            try: () => activePage.waitForNetworkIdle({ timeout: 10000 }),
            catch: (error) => new MegaDBError({ url, error }),
          });

          // Close any popups that opened during load.
          yield* Effect.sleep(1000);
          yield* Effect.promise(() => closePopupPages(browser as any, activePage)).pipe(
            Effect.catchAll(() => Effect.void)
          );

          let downloadUrl: string | undefined;
          let attempts = 0;
          const maxAttempts = 30; // Wait up to 30 attempts (about 30 seconds)

          // Look for common download button selectors on MegaDB
          const downloadButtonSelectors = [
            'a[href*="download"]',
            '.download-button',
            '.btn-download',
            'button[onclick*="download"]',
            '.download-link',
            'a.btn',
            'button.btn'
          ];

          // Wait for any download button to appear
          yield* Effect.tryPromise({
            try: async () => {
              for (const selector of downloadButtonSelectors) {
                try {
                  await activePage.waitForSelector(selector, { timeout: 2000 });
                  break;
                } catch {
                  // Continue to next selector
                }
              }
            },
            catch: (error) => new MegaDBError({ url, error: 'No download button found' }),
          });

          // Set up download detection before any clicks happen
          const downloadPromise = Effect.async<string | undefined, DownloadCatcherError>((resume) => {
            (async () => {
              try {
                const cdp = await createCdpSessionSafe(activePage as any);
                await cdp.send('Browser.setDownloadBehavior', {
                  behavior: 'allow',
                  downloadPath: '/tmp',
                  eventsEnabled: true,
                });

                const isDownloadEvent = (e: unknown): e is { url: string; guid: string } => {
                  return typeof e === 'object' && e !== null && 'url' in e && 'guid' in e;
                };

                cdp.on('Browser.downloadWillBegin', (event: unknown) => {
                  if (!isDownloadEvent(event)) return;
                  console.log(`[MegaDB] Download detected: ${event.url}, guid: ${event.guid}`);
                  cdp.send('Browser.cancelDownload', { guid: event.guid })
                    .then(() => {
                      console.log(`[MegaDB] Download cancelled successfully: ${event.guid}`);
                      resume(Effect.succeed(event.url));
                    })
                    .catch((error: unknown) => {
                      console.error(`[MegaDB] Failed to cancel download:`, error);
                      // Even if cancel fails, we still got the URL, so succeed with the URL
                      // The file will download to /tmp but we have what we need
                      resume(Effect.succeed(event.url));
                    });
                });

                // Wait for user to trigger download (up to 60 seconds)
                setTimeout(() => {
                  resume(Effect.succeed(undefined));
                }, 60000);
              } catch (error) {
                resume(Effect.fail(new DownloadCatcherError({ error })));
              }
            })();
          });

          // Wait for download to be triggered by user
          downloadUrl = yield* downloadPromise;

          if (!downloadUrl) {
            return yield* Effect.fail(
              new MegaDBError({
                url,
                error: 'No download was detected within the timeout period',
              })
            );
          }

          // Get headers from the download URL
          const headers: Record<string, string> = yield* Effect.tryPromise({
            try: async () => {
              const client = await createCdpSessionSafe(activePage as any);
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

              // Try to trigger a HEAD request to get headers
              try {
                await activePage.evaluate((url: string | URL | Request) => {
                  return fetch(url, { method: 'HEAD', credentials: 'include' });
                }, downloadUrl);
              } catch {
                // Ignore fetch errors
              }

              // Wait for the event to fire
              await new Promise((resolve) => setTimeout(resolve, 2000));
              client.off?.('Network.responseReceived', handler);
              await client.detach?.();
              return foundHeaders;
            },
            catch: (error) => new MegaDBError({ url, error }),
          });

          return [
            {
              url: downloadUrl,
              name: 'MEGADB',
              headers,
            },
          ];
        }.bind(this)),
      ({ browser }) =>
        Effect.promise(async () => {
          try {
            (browser as any).removeAllListeners?.("targetcreated");
          } catch {}
          await browser.close();
        })
    );
  }
}
