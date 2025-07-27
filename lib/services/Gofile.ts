import puppeteer from "puppeteer-extra";
import { DLService, PUPPETEER_OPTIONS } from "./BaseService";
import stealth from "puppeteer-extra-plugin-stealth";
import adblock from "puppeteer-extra-plugin-adblocker";
import { Effect } from "effect";
import { GofilePasswordRequiredError, GofileScrapeError, DownloadCatcherError } from "../errors";
import type { Browser, Page, ElementHandle } from "puppeteer";
import type { EventResponse, SearchResult } from "ogi-addon";

export default class GofileService extends DLService {
  public constructor() {
    super('Gofile', 3);
  }

  scrapeDownloadLinks(url: string, event: EventResponse<SearchResult>): Effect.Effect<{ name: string; url: string; }[], GofilePasswordRequiredError | GofileScrapeError | DownloadCatcherError> {
    puppeteer.use(stealth());
    puppeteer.use(adblock());

    const acquireBrowser = Effect.tryPromise({
      try: () => puppeteer.launch(PUPPETEER_OPTIONS),
      catch: (error) => new GofileScrapeError({ url, error })
    });

    return Effect.acquireUseRelease(
      acquireBrowser,
      (browser: Browser) => Effect.gen(function*(this: GofileService) {
        const page: Page = yield* Effect.tryPromise({
          try: () => browser.newPage(),
          catch: (error) => new GofileScrapeError({ url, error })
        });

        yield* Effect.tryPromise({
          try: () => page.goto(url, { waitUntil: 'networkidle2' }),
          catch: (error) => new GofileScrapeError({ url, error })
        });

        yield* Effect.tryPromise({
          try: () => page.waitForSelector('#filemanager_itemslist', { timeout: 10000 }),
          catch: (error) => new GofileScrapeError({ url, error })
        });

        const passwordForm: ElementHandle<Element> | null = yield* Effect.tryPromise({
          try: () => page.$('#filemanager_alert_passwordform'),
          catch: (error) => new GofileScrapeError({ url, error })
        });

        if (passwordForm) {
          const isVisible: boolean = yield* Effect.tryPromise({
            try: () => page.evaluate((el: Element) => !el.classList.contains('hidden'), passwordForm),
            catch: (error) => new GofileScrapeError({ url, error })
          });
          if (isVisible) {
            return yield* Effect.fail(new GofilePasswordRequiredError({ url }));
          }
        }

        yield* Effect.tryPromise({
          try: () => page.waitForSelector('.item_download', { timeout: 5000 }),
          catch: (error) => new GofileScrapeError({ url, error })
        });
        
        const fileItems: { name: string, downloadButtonIndex: number }[] = yield* Effect.tryPromise({
          try: () => page.evaluate(() => {
            const items: { name: string, downloadButtonIndex: number }[] = [];
            const fileElements = document.querySelectorAll('[data-item-id]');
            
            fileElements.forEach((element, index) => {
              const nameElement = element.querySelector('.item_open') as HTMLElement;
              if (nameElement) {
                const fileName = nameElement.textContent?.trim() || `file_${index}`;
                const downloadButton = element.querySelector('.item_download');
                if (downloadButton) {
                  items.push({ name: fileName, downloadButtonIndex: index });
                }
              }
            });
            
            return items;
          }),
          catch: (error) => new GofileScrapeError({ url, error })
        });

        const downloadResults = yield* Effect.forEach(fileItems, (fileItem) => Effect.gen(function*(this: GofileService) {
          const downloadButtons = yield* Effect.tryPromise({
            try: () => page.$$('.item_download'),
            catch: (error) => new GofileScrapeError({ url, error })
          });

          if (downloadButtons[fileItem.downloadButtonIndex]) {
            const downloadUrl = yield* this.downloadCatcher(page, downloadButtons[fileItem.downloadButtonIndex]);
            if (downloadUrl) {
              return {
                name: fileItem.name,
                url: downloadUrl
              };
            }
          }
          return undefined;
        }.bind(this)), { concurrency: "inherit" });
        
        const filteredResults = downloadResults.filter((result): result is { name: string; url: string } => !!result);

        console.log("Download results", filteredResults);
        return filteredResults;
      }.bind(this)),
      (browser) => Effect.promise(() => browser.close())
    );
  }
}