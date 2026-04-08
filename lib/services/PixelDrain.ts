import { DLService, PUPPETEER_OPTIONS, launchStandardBrowser } from "./BaseService";
import { Effect } from "effect";
import { PixelDrainError, DownloadCatcherError } from "../errors";
import type { EventResponse, SearchResult } from "ogi-addon";
import type { Browser, Page } from "puppeteer";

export default class PixelDrainService extends DLService {
  public constructor() {
    super('PixelDrain', 8);
  }

  scrapeDownloadLinks(url: string, event: EventResponse<SearchResult>): Effect.Effect<{ name: string; url: string; headers: Record<string, string> }[], PixelDrainError | DownloadCatcherError> {
    const acquireConn = Effect.tryPromise({
      try: async () => {
        const { browser, page } = await launchStandardBrowser({ headless: PUPPETEER_OPTIONS.headless });
        return { browser, page } as { browser: Browser; page: Page };
      },
      catch: (error) => new PixelDrainError({ url, error })
    });

    return Effect.acquireUseRelease(
      acquireConn,
      ({ browser, page }) => Effect.gen(function*(this: PixelDrainService) {

        yield* Effect.tryPromise({
          try: () => page.goto(url),
          catch: (error) => new PixelDrainError({ url, error })
        });

        const buttons = yield* Effect.tryPromise({
          try: () => page.$$('button.button_highlight'),
          catch: (error) => new PixelDrainError({ url, error })
        });

        if (buttons.length === 0) {
          return yield* Effect.fail(new PixelDrainError({ url, error: 'No download button candidates found' }));
        }
        
        let downloadButton: (typeof buttons)[number] | undefined;
        for (const button of buttons) {
          const isDownload = yield* Effect.tryPromise({
            try: () => button.evaluate(el => 
              Array.from(el.children).some(child => 
                child.tagName === 'I' && child.className.includes('icon') && child.textContent === 'download'
              )
            ),
            catch: (error) => new PixelDrainError({ url, error })
          });
          if (isDownload) {
            downloadButton = button;
            break;
          }
        }
        
        if (!downloadButton) {
          return yield* Effect.fail(new PixelDrainError({ url, error: 'No download button found' }));
        }

        const downloadUrl = yield* this.downloadCatcher(page, downloadButton);

        if (!downloadUrl) {
          return yield* Effect.fail(new PixelDrainError({ url, error: 'No download url found' }));
        }

        return [{ name: 'PIXELDRAIN', url: downloadUrl, headers: {} }];
      }.bind(this)),
      ({ browser }) => Effect.promise(() => browser.close())
    );
  }
}
