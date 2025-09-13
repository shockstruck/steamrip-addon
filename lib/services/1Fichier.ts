import { DLService, PUPPETEER_OPTIONS, launchStandardBrowser } from "./BaseService";
import { Effect } from "effect";
import { FichierError } from "../errors";
import type { EventResponse, SearchResult } from "ogi-addon";
import type { Browser, Page } from "puppeteer";

export default class FichierService extends DLService {
  public constructor() {
    super('Fichier', 9);
  }

  scrapeDownloadLinks(url: string, event: EventResponse<SearchResult>): Effect.Effect<{ name: string; url: string; headers: Record<string, string> }[], FichierError> {
    const acquireConn = Effect.tryPromise({
      try: async () => {
        const { browser, page } = await launchStandardBrowser({ headless: PUPPETEER_OPTIONS.headless, args: PUPPETEER_OPTIONS.args });
        return { browser, page } as { browser: Browser; page: Page };
      },
      catch: (error) => new FichierError({ url, error })
    });

    return Effect.acquireUseRelease(
      acquireConn,
      ({ browser, page }) => Effect.gen(function*() {
        yield* Effect.tryPromise({
          try: () => (browser as any).deleteCookie?.(),
          catch: (error) => new FichierError({ url, error })
        });

        yield* Effect.tryPromise({
          try: () => page.goto(url),
          catch: (error) => new FichierError({ url, error })
        });

        yield* Effect.tryPromise({
          try: () => page.evaluate(() => {
            const form: HTMLFormElement | null = document.querySelector('form.alc');
            if (!form) throw new Error('Form not found');
            form.submit();
          }),
          catch: (error) => new FichierError({ url, error })
        });

        yield* Effect.tryPromise({
          try: () => page.waitForNavigation(),
          catch: (error) => new FichierError({ url, error })
        });

        const hasCountdown = yield* Effect.tryPromise({
          try: () => page.evaluate(() => document.querySelector(".flip-clock-wrapper") !== null),
          catch: (error) => new FichierError({ url, error })
        });

        if (hasCountdown) {
          console.log('Countdown detected, handling timer...');
          yield* Effect.tryPromise({
            try: () => page.evaluate(() => {
              return new Promise<void>((resolve, reject) => {
                const clock = document.querySelectorAll(".flip-clock-wrapper ul.flip");
                if (clock.length < 2) return reject("Clock not found");

                const tensElement = clock[0]?.querySelector(".flip-clock-active .inn");
                const onesElement = clock[1]?.querySelector(".flip-clock-active .inn");
                if (!tensElement || !onesElement) return reject("Clock elements not found");

                const tens = tensElement.textContent?.trim();
                const ones = onesElement.textContent?.trim();
                if (!tens || !ones) return reject("Clock text not found");

                const countdownStart = parseInt(tens + ones, 10);
                if (isNaN(countdownStart)) return reject("Couldn't extract countdown digits");
                
                const wrapper = document.querySelector(".flip-clock-wrapper");
                if (wrapper) wrapper.innerHTML = `<div id="local-countdown" style="font-size: 24px; text-align: center; margin-top: 20px;">Please wait ${countdownStart} seconds...</div>`;
                
                let seconds = countdownStart;
                const interval = setInterval(() => {
                  seconds--;
                  const timerDiv = document.getElementById("local-countdown");
                  if (seconds <= 0) {
                    clearInterval(interval);
                    if (timerDiv) timerDiv.textContent = "Ready to download!";
                    const dlw = document.getElementById("dlw");
                    const dlb = document.getElementById("dlb");
                    if (dlw) (dlw as HTMLElement).style.display = "none";
                    if (dlb) (dlb as HTMLElement).style.display = "block";
                    resolve();
                  } else {
                    if (timerDiv) timerDiv.textContent = `Please wait ${seconds} seconds...`;
                  }
                }, 1000);
              });
            }),
            catch: (error) => new FichierError({ url, error })
          });

          yield* Effect.tryPromise({
            try: () => page.evaluate(() => {
              const button: HTMLElement | null = document.getElementById('dlb');
              if (button) button.click();
              else throw new Error("Download button not found after countdown");
            }),
            catch: (error) => new FichierError({ url, error })
          });

          yield* Effect.tryPromise({
            try: () => page.waitForNavigation(),
            catch: (error) => new FichierError({ url, error })
          });
        }

        const okButton = yield* Effect.tryPromise({
          try: () => page.$('a.ok.btn-general.btn-orange'),
          catch: (error) => new FichierError({ url, error })
        });

        if (okButton) {
          const href = yield* Effect.tryPromise({
            try: () => okButton.evaluate(el => el.getAttribute('href')),
            catch: (error) => new FichierError({ url, error })
          });
          if (href) {
            console.log('found ok button', href);
            return [{ url: href, name: '1FICHIER', headers: {} }];
          }
        }

        return [];
      }),
      ({ browser }) => Effect.promise(() => browser.close())
    );
  }
}