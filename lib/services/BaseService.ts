import { Effect } from "effect";
import type { ElementHandle, Page } from "puppeteer";
import puppeteer, { type VanillaPuppeteer } from "puppeteer-extra";
import { DownloadCatcherError } from "../errors";
import type { EventResponse, SearchResult } from "ogi-addon";
export const PUPPETEER_OPTIONS: Parameters<VanillaPuppeteer["launch"]>[0] = {
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-sync",
    "--ignore-certificate-errors",
    "--lang=en-US,en;q=0.9",
  ],
  defaultViewport: { width: 1920, height: 1080 }
}

export class DLService {
  public name: string;
  public priority: number;
  public constructor(name: string, priority: number) {
    this.name = name;
    this.priority = priority;
  }

  isCaptchaBased(): boolean {
    return false;
  }

  scrapeDownloadLinks(url: string, event: EventResponse<SearchResult>): Effect.Effect<{ name: string, url: string; headers: Record<string, string> }[], Error> {
    return Effect.die(new Error('Not implemented'));
  }

  downloadCatcher(page: Page, downloadButton: ElementHandle<Element>): Effect.Effect<string | undefined, DownloadCatcherError> {
    return Effect.async<string | undefined, DownloadCatcherError>((resume) => {
      Effect.runPromise(Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => downloadButton.click(),
          catch: (error) => new DownloadCatcherError({ error })
        });
        console.log('clicked download button');

        const cdp = yield* Effect.tryPromise({
          try: () => page.createCDPSession(),
          catch: (error) => new DownloadCatcherError({ error })
        });
        console.log('created cdp session');

        yield* Effect.tryPromise({
          try: () => cdp.send('Browser.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: '/tmp',
            eventsEnabled: true,
          }),
          catch: (error) => new DownloadCatcherError({ error })
        });

        cdp.on('Browser.downloadWillBegin', (event) => {
          console.log(event.url);
          // cancel the download
          cdp.send('Browser.cancelDownload', {
            guid: event.guid,
          }).then(() => {
            resume(Effect.succeed(event.url));
          }).catch((error) => {
            resume(Effect.fail(new DownloadCatcherError({ error })));
          });
        });

        console.log('waiting for download to begin');
        // wait 5 seconds, and if not resolved, reject
        setTimeout(() => {
          resume(Effect.succeed(undefined));
        }, 5000);
      })).catch((error) => {
        resume(Effect.fail(new DownloadCatcherError({ error })))
      });
    });
  }
}
