import { Effect } from "effect";
import { DownloadCatcherError } from "../errors";
import type { EventResponse, SearchResult } from "ogi-addon";
import puppeteer from "puppeteer-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import adblock from "puppeteer-extra-plugin-adblocker";
import type { Browser, Page } from "puppeteer";

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

// Structural types to avoid cross-library type conflicts
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: unknown) => void): void;
}

export interface DownloadablePageLike {
  createCDPSession(): Promise<CdpSessionLike>;
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

  const launchOptions: LaunchOptions = {
    headless: options?.headless ?? PUPPETEER_OPTIONS.headless,
    defaultViewport:
      options?.defaultViewport ?? PUPPETEER_OPTIONS.defaultViewport,
    args: [
      ...(PUPPETEER_OPTIONS.args ?? []),
      ...((options?.args as string[] | undefined) ?? []),
    ],
    protocolTimeout: options?.protocolTimeout ?? PUPPETEER_OPTIONS.protocolTimeout ?? 180000,
  } as LaunchOptions;

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
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
          const cdp: CdpSessionLike = await page.createCDPSession();
          console.log("created cdp session");
          console.log('clicking download button...')
          await downloadButton.click({ delay: 1000, count: 2 });
          console.log("clicked download button");

          await cdp.send("Browser.setDownloadBehavior", {
            behavior: "allow",
            downloadPath: "/tmp",
            eventsEnabled: true,
          });

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
