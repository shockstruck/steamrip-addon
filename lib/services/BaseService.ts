import { Effect } from "effect";
import { DownloadCatcherError } from "../errors";
import type { EventResponse, SearchResult } from "ogi-addon";
import puppeteer from "puppeteer-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import adblock from "puppeteer-extra-plugin-adblocker";
import type { Browser, Page } from "puppeteer";
import { connect } from "puppeteer-real-browser";
import { existsSync } from "fs";

// Minimal options used for puppeteer-real-browser connect
export interface RealBrowserLaunchOptions {
  headless?: boolean;
  args?: string[];
  defaultViewport?: { width: number; height: number };
  protocolTimeout?: number;
}

export const PUPPETEER_OPTIONS: RealBrowserLaunchOptions = {
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-sync",
    "--ignore-certificate-errors",
    "--start-minimized",
    "--lang=en-US,en;q=0.9",
  ],
  defaultViewport: { width: 1024, height: 700 },
  protocolTimeout: 180000, // 3 minutes to handle slow Cloudflare challenges
};

const BLANK_BROWSER_URL_PREFIXES = [
  "about:blank",
  "chrome://newtab",
  "chrome://new-tab-page",
  "chrome-search://local-ntp",
  "data:,",
] as const;

export interface BrowserPageLike {
  url(): string;
  isClosed(): boolean;
  close?(): Promise<void>;
  bringToFront?(): Promise<void>;
}

export interface BrowserWithPagesLike<TPage extends BrowserPageLike = BrowserPageLike> {
  pages(): Promise<TPage[]>;
  newPage?(): Promise<TPage>;
}

export interface NavigablePageLike extends BrowserPageLike {
  goto(url: string, options?: Parameters<Page["goto"]>[1]): Promise<unknown>;
}

export function isBlankBrowserPageUrl(url: string | null | undefined): boolean {
  if (!url) {
    return true;
  }

  return BLANK_BROWSER_URL_PREFIXES.some(prefix => url.startsWith(prefix));
}

function getPageUrl(page: BrowserPageLike): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function dedupeArgs(args: string[]): string[] {
  return [...new Set(args)];
}

export function normalizeBrowserArgs(args: string[] = [], options?: { headless?: boolean }): string[] {
  const headless = options?.headless ?? true;
  const normalizedArgs = headless ? args : args.filter(arg => arg !== "--start-minimized");
  return dedupeArgs(normalizedArgs);
}

function buildBrowserArgs(args: string[] = [], options?: { headless?: boolean }): string[] {
  return normalizeBrowserArgs([...(PUPPETEER_OPTIONS.args ?? []), ...args], options);
}

export function resolveBrowserExecutablePath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
): string | undefined {
  const configuredPath = env.CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH;
  if (configuredPath && pathExists(configuredPath)) return configuredPath;

  if (platform === "linux" && (arch === "arm64" || arch === "aarch64")) {
    return [
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
    ].find(pathExists);
  }

  return undefined;
}

export function pickPrimaryBrowserPage<TPage extends BrowserPageLike>(
  pages: TPage[],
  fallback?: TPage
): TPage | undefined {
  const openPages = pages.filter(page => page && !page.isClosed());
  const fallbackPage = fallback && !fallback.isClosed() ? fallback : undefined;

  if (openPages.length === 0) {
    return fallbackPage;
  }

  const nonBlankPages = openPages.filter(page => !isBlankBrowserPageUrl(getPageUrl(page)));
  return nonBlankPages.at(-1) ?? openPages.at(-1) ?? fallbackPage;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function stabilizeBrowserPage<TPage extends BrowserPageLike>(
  browser: BrowserWithPagesLike<TPage>,
  fallback: TPage,
  options?: { attempts?: number; settleMs?: number }
): Promise<TPage> {
  let page = fallback;
  const attempts = options?.attempts ?? 5;
  const settleMs = options?.settleMs ?? 150;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const pages = await browser.pages().catch(() => [] as TPage[]);
    page = pickPrimaryBrowserPage(pages, page) ?? page;

    if (!isBlankBrowserPageUrl(getPageUrl(page))) {
      break;
    }

    if (attempt < attempts - 1) {
      await sleep(settleMs);
    }
  }

  await page.bringToFront?.().catch(() => undefined);
  return page;
}

async function recoverBrowserPage<TPage extends NavigablePageLike>(
  browser: BrowserWithPagesLike<TPage>,
  currentPage: TPage
): Promise<TPage> {
  const stabilizedPage = await stabilizeBrowserPage(browser, currentPage);
  if (stabilizedPage !== currentPage && !stabilizedPage.isClosed()) {
    return stabilizedPage;
  }

  if (typeof browser.newPage === "function") {
    const freshPage = await browser.newPage();
    return await stabilizeBrowserPage(browser, freshPage);
  }

  return stabilizedPage;
}

export async function navigateBrowserPage<TPage extends NavigablePageLike>(
  browser: BrowserWithPagesLike<TPage>,
  initialPage: TPage,
  url: string,
  options?: Parameters<Page["goto"]>[1]
): Promise<TPage> {
  let page = await stabilizeBrowserPage(browser, initialPage);
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.bringToFront?.().catch(() => undefined);
      await page.goto(url, options);

      const currentUrl = getPageUrl(page);
      if (!isBlankBrowserPageUrl(currentUrl)) {
        return page;
      }

      lastError = new Error(`Browser stayed on ${currentUrl || "a blank page"} while navigating to ${url}`);
    } catch (error) {
      lastError = error;
    }

    page = await recoverBrowserPage(browser, page);
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error(`Failed to navigate browser page to ${url}`);
}

type RealBrowserConnectOptions = Parameters<typeof connect>[0] & {
  defaultViewport?: { width: number; height: number } | null;
};

type RealBrowserConnectResult = Awaited<ReturnType<typeof connect>>;

export async function connectRealBrowser(
  options: RealBrowserConnectOptions = {}
): Promise<RealBrowserConnectResult> {
  const headless = options.headless ?? false;
  const connectResult = await connect({
    ...options,
    headless,
    args: buildBrowserArgs(options.args, { headless }),
    connectOption: {
      defaultViewport: options.connectOption?.defaultViewport ?? options.defaultViewport ?? PUPPETEER_OPTIONS.defaultViewport,
      ...(options.connectOption ?? {}),
    },
  });

  const page = await stabilizeBrowserPage(connectResult.browser as unknown as BrowserWithPagesLike<RealBrowserConnectResult["page"]>, connectResult.page);
  return { ...connectResult, page };
}

// Structural types to avoid cross-library type conflicts
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: unknown) => void): void;
  off?(event: string, listener: (params: unknown) => void): void;
  detach?(): Promise<void>;
}

export interface DownloadablePageLike {
  createCDPSession?: () => Promise<CdpSessionLike>;
  target?: () => { createCDPSession: () => Promise<CdpSessionLike> };
}

export interface ClickableHandleLike {
  click(options?: Record<string, unknown>): Promise<void>;
}

/**
 * Launch a standard Puppeteer browser using puppeteer-extra with plugins enabled.
 * Returns a new browser and a new page.
 */
type LaunchOptions = Parameters<typeof puppeteer.launch>[0];

export async function launchStandardBrowser(
  options?: Partial<LaunchOptions & RealBrowserLaunchOptions>
): Promise<{ browser: Browser; page: Page }> {
  // Register plugins (idempotent across multiple calls)
  puppeteer.use(stealth());
  puppeteer.use(adblock());

  const headless = options?.headless ?? PUPPETEER_OPTIONS.headless;
  const launchOptions: LaunchOptions = {
    headless,
    defaultViewport:
      options?.defaultViewport ?? PUPPETEER_OPTIONS.defaultViewport,
    args: buildBrowserArgs((options?.args as string[] | undefined) ?? [], { headless: headless !== false }),
    protocolTimeout: options?.protocolTimeout ?? PUPPETEER_OPTIONS.protocolTimeout ?? 180000,
    executablePath:
      options?.executablePath ?? resolveBrowserExecutablePath(),
  } as LaunchOptions;

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  await page.bringToFront().catch(() => undefined);
  return { browser, page };
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

  scrapeDownloadLinks(
    url: string,
    event: EventResponse<SearchResult>
  ): Effect.Effect<
    { name: string; url: string; headers: Record<string, string> }[],
    Error
  > {
    return Effect.die(new Error("Not implemented"));
  }

  downloadCatcher(
    page: DownloadablePageLike,
    downloadButton: ClickableHandleLike
  ): Effect.Effect<string | undefined, DownloadCatcherError> {
    return Effect.async<string | undefined, DownloadCatcherError>((resume) => {
      (async () => {
        let timeoutHandle: NodeJS.Timeout | null = null;
        let resolved = false;
        try {
          const cdp: CdpSessionLike = await createCdpSessionSafe(page);

          await cdp.send("Browser.setDownloadBehavior", {
            behavior: "allow",
            downloadPath: "/tmp",
            eventsEnabled: true,
          });

          console.log("created cdp session");
          console.log('clicking download button...')
          downloadButton.click({ delay: 1000 });
          console.log("clicked download button");


          const isDownloadEvent = (
            e: unknown
          ): e is { url: string; guid: string } => {
            return (
              typeof e === "object" && e !== null && "url" in e && "guid" in e
            );
          };

          const cleanup = () => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
              timeoutHandle = null;
            }
          };

          cdp.on("Browser.downloadWillBegin", (event: unknown) => {
            if (resolved) return;
            if (!isDownloadEvent(event)) return;
            cleanup();
            console.log("[DownloadCatcher] Download started:", event.url, "guid:", event.guid);
            
            // Try to cancel the download immediately
            cdp
              .send("Browser.cancelDownload", { guid: event.guid })
              .then(() => {
                console.log("[DownloadCatcher] Download cancelled successfully:", event.guid);
                resolved = true;
                resume(Effect.succeed(event.url));
              })
              .catch((error: unknown) => {
                console.error("[DownloadCatcher] Failed to cancel download:", error);
                resolved = true;
                resume(Effect.succeed(event.url));
              });
          });

          console.log("waiting for download to begin");
          timeoutHandle = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            resume(
              Effect.fail(
                new DownloadCatcherError({
                  error: "Timed out waiting for download (8s)",
                })
              )
            );
          }, 8000);
        } catch (error) {
          if (!resolved) {
            resolved = true;
            resume(Effect.fail(new DownloadCatcherError({ error })));
          }
          console.error("error in download catcher", error);
        }
      })();
    });
  }
}

export async function createCdpSessionSafe(
  pageLike: DownloadablePageLike
): Promise<CdpSessionLike> {
  if (typeof pageLike.createCDPSession === "function") {
    return await pageLike.createCDPSession();
  }
  if (typeof pageLike.target === "function") {
    return await pageLike.target().createCDPSession();
  }
  throw new Error(
    "Cannot create CDP session: pageLike lacks createCDPSession() and target().createCDPSession()"
  );
}
