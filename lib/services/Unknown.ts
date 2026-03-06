
import { DLService, PUPPETEER_OPTIONS, launchStandardBrowser } from "./BaseService";
import { Effect } from "effect";
import { DownloadCatcherError, UnknownServiceError } from "../errors";
import type { EventResponse, SearchResult } from "ogi-addon";
import { ConfigurationBuilder } from "ogi-addon";
import { connect } from "puppeteer-real-browser";
import { PuppeteerExtraPluginAdblocker } from "puppeteer-extra-plugin-adblocker";

export default class UnknownService extends DLService {
  public constructor() {
    super('Unknown', 1); // Low priority since it's a fallback
  }

  isCaptchaBased(): boolean {
    return true; // Similar to FileCrypt, requires user interaction
  }

  scrapeDownloadLinks(
    url: string,
    event: EventResponse<SearchResult>
  ): Effect.Effect<
    { name: string; url: string; headers: Record<string, string> }[],
    UnknownServiceError | DownloadCatcherError
  > {
    
    const acquireConn = Effect.tryPromise({
      try: async () => {
        await event.askForInput(
          'Unknown Service Download',
          'A browser window will open to ' + new URL(url).hostname + '. Please start the download for the file and our system will catch the download and start the process.',
          new ConfigurationBuilder()
        )
        console.log('Acquiring connection to', new URL(url).hostname);
        const { browser, page } = await connect({ 
          headless: false, // Non-headless like FileCrypt for user interaction
          args: PUPPETEER_OPTIONS.args ,
          plugins: [
            new PuppeteerExtraPluginAdblocker({
              blockTrackers: true,
              blockTrackersAndAnnoyances: true,
              useCache: true
            })
          ]
        });
        console.log('Acquired connection to', new URL(url).hostname);
        return { browser, page };
      },
      catch: (error) => {
        console.error('Error acquiring connection', error);
        return new UnknownServiceError({ url, error });
      }
    });

    return Effect.acquireUseRelease( 
      acquireConn,
      ({ browser, page }) =>
        Effect.gen(function* (this: UnknownService) {
          console.log('Navigating to', url);
          yield* Effect.tryPromise({
            try: () => page.goto(url, { waitUntil: 'domcontentloaded' }),
            catch: (error) => new UnknownServiceError({ url, error }),
          });
          // Notify user about captcha/interaction requirement

          let downloadUrl: string | undefined;

          // Set up download detection before any clicks happen
          const downloadPromise = Effect.async<string | undefined, DownloadCatcherError>((resume) => {
            (async () => {
              try {
                const cdp = await page.target().createCDPSession();
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
                  console.log(`[Unknown Service] Download detected: ${event.url}, guid: ${event.guid}`);
                  cdp.send('Browser.cancelDownload', { guid: event.guid })
                    .then(() => {
                      console.log(`[Unknown Service] Download cancelled successfully: ${event.guid}`);
                      resume(Effect.succeed(event.url));
                    })
                    .catch((error: unknown) => {
                      console.error(`[Unknown Service] Failed to cancel download:`, error);
                      // Even if cancel fails, we still got the URL, so succeed with the URL
                      // The file will download to /tmp but we have what we need
                      resume(Effect.succeed(event.url));
                    });
                });

                // Wait for user to trigger download (up to 5 minutes)
                setTimeout(() => {
                  resume(Effect.succeed(undefined));
                }, 5 * 60 * 1000);
              } catch (error) {
                resume(Effect.fail(new DownloadCatcherError({ error })));
              }
            })();
          });

          // Wait for download to be triggered by user
          downloadUrl = yield* downloadPromise;

          if (!downloadUrl) {
            return yield* Effect.fail(
              new UnknownServiceError({
                url,
                error: 'No download was detected within the timeout period',
              })
            );
          }

          // Get headers from the download URL
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

              // Try to trigger a HEAD request to get headers
              try {
                await page.evaluate((url) => {
                  return fetch(url, { method: 'HEAD', credentials: 'include' });
                }, downloadUrl);
              } catch {
                // Ignore fetch errors
              }

              // Wait for the event to fire
              await new Promise((resolve) => setTimeout(resolve, 2000));
              client.off('Network.responseReceived', handler);
              await client.detach();
              return foundHeaders;
            },
            catch: (error) => new UnknownServiceError({ url, error }),
          });

          return [
            {
              url: downloadUrl,
              name: 'UNKNOWN_SERVICE',
              headers,
            },
          ];
        }.bind(this)),
      ({ browser }) => Effect.promise(() => browser.close())
    );
  }
}
