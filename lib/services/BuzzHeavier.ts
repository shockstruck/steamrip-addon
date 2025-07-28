import { DLService, PUPPETEER_OPTIONS } from "./BaseService";
import puppeteer from "puppeteer-extra";
import { type Browser, type ElementHandle } from "puppeteer";
import { Effect, pipe } from "effect";
import { BuzzHeavierError, DownloadCatcherError } from "../errors";
import type { EventResponse, SearchResult } from "ogi-addon";

export default class BuzzheavierService extends DLService {
  public constructor() {
    super('Buzzheavier', 7);
  }

  scrapeDownloadLinks(url: string, event: EventResponse<SearchResult>): Effect.Effect<{ name: string; url: string; headers: Record<string, string> }[], BuzzHeavierError | DownloadCatcherError> {
    const acquireBrowser = Effect.tryPromise({
      try: () => puppeteer.launch(PUPPETEER_OPTIONS),
      catch: (error) => new BuzzHeavierError({ url, error })
    });

    return Effect.acquireUseRelease(
      acquireBrowser,
      (browser: Browser) => Effect.gen(function*(this: BuzzheavierService) {
        const page = yield* Effect.tryPromise({
          try: () => browser.newPage(),
          catch: (error) => new BuzzHeavierError({ url, error })
        });

        yield* Effect.tryPromise({
          try: () => page.goto(url),
          catch: (error) => new BuzzHeavierError({ url, error })
        });
        
        yield* Effect.tryPromise({
          try: () => page.evaluate(() => { (window as any).adLink = null; }),
          catch: (error) => new BuzzHeavierError({ url, error })
        });

        yield* Effect.tryPromise({
          try: () => page.waitForSelector('.link-button.gay-button'),
          catch: (error) => new BuzzHeavierError({ url, error })
        });

        const buttons = yield* Effect.tryPromise({
          try: () => page.$$('.link-button.gay-button'),
          catch: (error) => new BuzzHeavierError({ url, error })
        });

        let downloadButton: ElementHandle<Element> | undefined;
        for (const button of buttons) {
          const hxGet = yield* Effect.tryPromise({
            try: () => button.evaluate(el => el.getAttribute('hx-get')),
            catch: (error) => new BuzzHeavierError({ url, error })
          });
          if (hxGet?.includes('download')) {
            downloadButton = button;
            break;
          }
        }
        
        if (!downloadButton) {
          return yield* Effect.fail(new BuzzHeavierError({ url, error: 'No download button found' }));
        }

        let downloadUrl: string | undefined;
        let lastError: unknown = undefined;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            downloadUrl = yield* this.downloadCatcher(page, downloadButton);
            if (downloadUrl) break;
          } catch (err) {
            lastError = err;
          }
        }

        if (!downloadUrl) {
          return yield* Effect.fail(new BuzzHeavierError({ url, error: lastError ?? 'No download url found' }));
        }
        
        return [{
          url: downloadUrl,
          name: 'BUZZHEAVIER',
          headers: {}
        }];
      }.bind(this)),
      (browser) => Effect.promise(() => browser.close())
    );
  }
}