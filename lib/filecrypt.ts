import type { Browser, Page } from "puppeteer";
import { PUPPETEER_OPTIONS, launchStandardBrowser } from "./services/BaseService";
import { showInfoPopup } from "./popup-utils";
import { Effect } from "effect";
import { FileCryptBrowserClosedError, FileCryptRedirectError, FileCryptUrlError, NetworkError } from "./errors";
import type { PageWithCursor } from "puppeteer-real-browser";

/**
 * Detects if a URL is from filecrypt domain (any TLD)
 */
export function isFilecryptUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return /filecrypt\./i.test(urlObj.hostname);
  } catch {
    return false;
  }
}

/**
 * Interface for filecrypt processing options
 */
export interface FilecryptOptions {
  /** Timeout in milliseconds for waiting for redirects (default: 60000) */
  redirectTimeout?: number;
  /** Whether to run in headless mode (default: true) */
  headless?: boolean;
}

/**
 * Shows an informational popup explaining what will happen when processing a filecrypt URL
 */
function showFilecryptInfoPopup(url: string): Effect.Effect<void, never> {
  return Effect.tryPromise({
    try: () => showInfoPopup({
      title: "FileCrypt URL Detected",
      icon: "🔗",
      message: "We've detected a FileCrypt URL that needs processing:",
      infoBox: [
        { label: "URL", value: url }
      ],
      steps: [
        "A browser window will open to the FileCrypt page",
        "We'll wait for you to click 'Download' and get redirected to the download link", 
        "The final download URL will be used for OpenGameInstaller to process.",
      ],
      footerNote: "⏱️ This process typically takes 30-60 seconds",
      buttonText: "Continue with Processing",
      windowSize: { width: 650, height: 700 },
      testModeMessage: "Test Mode: This popup will close automatically"
    }),
    catch: (e) => new Error(`Popup failed to show: ${e}`)
  }).pipe(Effect.orDie);
}

/**
 * Processes a filecrypt URL and returns the final download URL after redirect
 */
export function processFilecryptUrl(url: string, options: FilecryptOptions = {}): Effect.Effect<string, FileCryptUrlError | FileCryptRedirectError | FileCryptBrowserClosedError | NetworkError> {
  if (!isFilecryptUrl(url)) {
    return Effect.fail(new FileCryptUrlError({ url }));
  }

  const {
    redirectTimeout = 20 * 60 * 1000,
    headless = false
  } = options;

  const acquireConn = Effect.tryPromise({
    try: async () => {
      const { browser, page } = await launchStandardBrowser({ headless, args: PUPPETEER_OPTIONS.args });
      return { browser, page } as { browser: Browser; page: Page };
    },
    catch: (error) => new NetworkError({ url, error })
  });

  return Effect.gen(function*() {
    console.log(`[filecrypt] Processing filecrypt URL: ${url}`);
    
    return yield* Effect.acquireUseRelease(
      acquireConn,
      ({ browser, page }) => Effect.gen(function*() {
        const finalUrl = yield* waitForFilecryptRedirect(page, url, redirectTimeout);
        
        if (isFilecryptUrl(finalUrl)) {
          return yield* Effect.fail(new FileCryptRedirectError({ url: finalUrl }));
        }

        console.log(`[filecrypt] Final download URL: ${finalUrl}`);
        return finalUrl;
      }),
      ({ browser }) => Effect.promise(() => browser.close())
    );
  });
}

/**
 * Waits for filecrypt to automatically redirect to the final download URL
 */
function waitForFilecryptRedirect(page: PageWithCursor | Page, initialUrl: string, timeout: number): Effect.Effect<string, FileCryptRedirectError | FileCryptBrowserClosedError> {
  const poll = (startTime: number): Effect.Effect<string, FileCryptRedirectError | FileCryptBrowserClosedError> => 
    Effect.gen(function*() {
      if (Date.now() - startTime > timeout) {
        return yield* Effect.fail(new FileCryptRedirectError({ url: initialUrl }));
      }
      if (page.isClosed()) {
        return yield* Effect.fail(new FileCryptBrowserClosedError());
      }

      const currentUrl = yield* Effect.try({
        try: () => page.url(),
        catch: () => new FileCryptBrowserClosedError()
      });

      if (!isFilecryptUrl(currentUrl)) {
        return currentUrl;
      }

      const navResult = yield* Effect.either(Effect.tryPromise({
        try: async () => {
          // Avoid type collisions by indirectly awaiting the promise
          const response = await (page as unknown as { waitForNavigation: (opts: any) => Promise<unknown> }).waitForNavigation({ waitUntil: "networkidle2", timeout: 1000 });
          return response as unknown;
        },
        catch: () => new FileCryptRedirectError({ url: currentUrl })
      }));

      if (navResult._tag === "Right") {
        const newUrl = page.url();
        if (!isFilecryptUrl(newUrl)) {
          return newUrl;
        }
      }

      yield* Effect.sleep("1 seconds");
      return yield* poll(startTime);
    });

  return Effect.gen(function*() {
    console.log(`[filecrypt] Loading page and waiting for redirect...`);
    
    yield* Effect.tryPromise({
      try: async () => {
        await (page as unknown as { goto: (url: string, opts: any) => Promise<unknown> }).goto(initialUrl, { waitUntil: "networkidle2", timeout: Math.min(timeout, 30000) });
        return null as unknown;
      },
      catch: () => new FileCryptRedirectError({ url: initialUrl })
    });

    const currentUrl = page.url();
    if (!isFilecryptUrl(currentUrl)) {
      console.log(`[filecrypt] Immediately redirected to: ${currentUrl}`);
      return currentUrl;
    }

    const finalUrl = yield* poll(Date.now());
    console.log(`[filecrypt] Redirected to: ${finalUrl}`);
    return finalUrl;
  });
}

/**
 * Utility function for processing filecrypt URL with default options
 */
export function processFilecryptWithPrompt(url: string): Effect.Effect<string, FileCryptUrlError | FileCryptRedirectError | FileCryptBrowserClosedError | NetworkError> {
  if (!isFilecryptUrl(url)) {
    return Effect.fail(new FileCryptUrlError({ url }));
  }

  console.log(`\n[filecrypt] Detected filecrypt URL: ${url}`);
  console.log(`[filecrypt] Waiting for automatic redirect to download link...`);

  return processFilecryptUrl(url, { 
    headless: true,
    redirectTimeout: 60000 // 60 second timeout
  });
}
