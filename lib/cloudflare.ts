import axios from "axios";
import { Data, Effect } from "effect";
import type OGIAddon from "ogi-addon";
import type { CookieParam, Page } from "puppeteer";
import type { PageWithCursor } from "puppeteer-real-browser";
import {
  convertPuppeteerCookies,
  headerManager,
  type Cookie,
  type HeaderData,
} from "./header-manager";
import { connectRealBrowser, navigateBrowserPage, PUPPETEER_OPTIONS } from "./services/BaseService";
import {
  getSteamripBrowserLaunchOptions,
  type SteamripBrowserMode,
} from "./steamrip-browser";
import { isCloudflareChallenge } from "./steamrip-fetch";

export class CloudflareTestError extends Data.TaggedError("CloudflareTestError")<{
  url: string;
  error: unknown;
}> {}

type SteamripPage = PageWithCursor | Page;

function hasCloudflareCookies(cookies: readonly Cookie[]): boolean {
  return cookies.some((cookie) =>
    cookie.name.includes("cf_") ||
    cookie.name.includes("__cf") ||
    cookie.name.includes("cloudflare") ||
    cookie.name === "cf_clearance"
  );
}

function isSteamripUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "steamrip.com" || hostname.endsWith(".steamrip.com");
  } catch {
    return false;
  }
}

async function waitForSteamripAccess(
  page: SteamripPage,
  timeoutSeconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let successfulChecks = 0;

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      return false;
    }

    const content = await page.content().catch(() => undefined);
    const currentUrl = page.url();

    if (
      content &&
      isSteamripUrl(currentUrl) &&
      !isCloudflareChallenge(200, {}, content)
    ) {
      successfulChecks++;
      if (successfulChecks >= 3) {
        return true;
      }
    } else {
      successfulChecks = 0;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

async function captureBrowserHeaders(
  page: SteamripPage,
  capturedHeaders: Record<string, string>,
): Promise<HeaderData> {
  const cookies = await page.cookies();
  const steamripCookies = cookies.filter((cookie) =>
    cookie.domain.includes("steamrip.com")
  );
  // The two Puppeteer packages expose equivalent runtime APIs with incompatible types.
  const evaluablePage = page as Page;
  const userAgent = await evaluablePage.evaluate(() => navigator.userAgent);
  const browserHeaders = await evaluablePage.evaluate(() => ({
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
    acceptLanguage: navigator.language || "en-US,en;q=0.9",
    acceptEncoding: "gzip, deflate, br",
    secFetchDest: "document",
    secFetchMode: "navigate",
    secFetchSite: "none",
  }));

  return {
    cookies: convertPuppeteerCookies(steamripCookies),
    userAgent,
    ...browserHeaders,
    ...capturedHeaders,
  };
}

async function openSteamrip(
  url: string,
  mode: SteamripBrowserMode,
  timeoutSeconds: number,
): Promise<HeaderData | undefined> {
  const { browser, page } = await connectRealBrowser(
    getSteamripBrowserLaunchOptions(mode),
  );

  try {
    const capturedHeaders: Record<string, string> = {};
    const storedCookies = headerManager.getCookies().map((cookie): CookieParam => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain?.startsWith(".")
        ? cookie.domain
        : (cookie.domain ?? ".steamrip.com"),
      path: cookie.path ?? "/",
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite as CookieParam["sameSite"],
    }));

    if (storedCookies.length > 0) {
      await (page as unknown as Page).setCookie(...storedCookies).catch(() => undefined);
    }

    const storedUserAgent = headerManager.getHeaders().userAgent;
    if (storedUserAgent) {
      await (page as unknown as Page).setUserAgent(storedUserAgent).catch(() => undefined);
    }

    const captureRequests = async (activePage: SteamripPage): Promise<void> => {
      await activePage.setRequestInterception(true);
      activePage.on("request", (request) => {
        if (
          request.url().includes("steamrip.com") &&
          Object.keys(capturedHeaders).length === 0
        ) {
          for (const [name, value] of Object.entries(request.headers())) {
            if (value && name.toLowerCase() !== "cookie") {
              capturedHeaders[name] = value;
            }
          }
        }
        void request.continue().catch(() => undefined);
      });
    };

    await captureRequests(page).catch(() => undefined);
    const activePage = await navigateBrowserPage(browser as any, page as any, url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (activePage !== page) {
      await captureRequests(activePage).catch(() => undefined);
    }

    if (!(await waitForSteamripAccess(activePage, timeoutSeconds))) {
      return undefined;
    }

    return await captureBrowserHeaders(activePage, capturedHeaders);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export const cloudflareSolve = (url: string, addon: OGIAddon) =>
  Effect.gen(function* () {
    yield* headerManager.loadHeaders();

    const testAccess = () =>
      Effect.tryPromise({
        try: () => axios.get<string>(url, {
          headers: headerManager.getHeaderObject(),
          timeout: 10_000,
          validateStatus: () => true,
          responseType: "text",
        }),
        catch: (error) => new CloudflareTestError({ url, error }),
      }).pipe(Effect.option);

    if (headerManager.hasValidCloudflareHeaders()) {
      const cachedResponse = yield* testAccess();
      if (
        cachedResponse._tag === "Some" &&
        cachedResponse.value.status >= 200 &&
        cachedResponse.value.status < 300 &&
        !isCloudflareChallenge(
          cachedResponse.value.status,
          cachedResponse.value.headers,
          cachedResponse.value.data,
        )
      ) {
        return headerManager.getHeaders();
      }

      if (
        cachedResponse._tag === "Some" &&
        isCloudflareChallenge(
          cachedResponse.value.status,
          cachedResponse.value.headers,
          cachedResponse.value.data,
        )
      ) {
        yield* headerManager.clearHeaders();
      }
    }

    const directResponse = yield* testAccess();
    if (
      directResponse._tag === "Some" &&
      directResponse.value.status >= 200 &&
      directResponse.value.status < 300 &&
      !isCloudflareChallenge(
        directResponse.value.status,
        directResponse.value.headers,
        directResponse.value.data,
      )
    ) {
      headerManager.requiresCloudflare = false;
      return headerManager.getHeaders();
    }

    process.env.PUPPETEER_PROTOCOL_TIMEOUT = String(
      PUPPETEER_OPTIONS.protocolTimeout || 180_000,
    );

    const backgroundHeaders = yield* Effect.tryPromise({
      try: () => openSteamrip(url, "background", 7),
      catch: (error) => new CloudflareTestError({ url, error }),
    }).pipe(
      Effect.catchAll((error) => {
        console.log("Background Steamrip check failed, trying a visible browser:", error);
        return Effect.succeed(undefined);
      }),
    );

    if (backgroundHeaders) {
      headerManager.requiresCloudflare = hasCloudflareCookies(backgroundHeaders.cookies);
      yield* headerManager.setHeaders(backgroundHeaders);
      return backgroundHeaders;
    }

    yield* Effect.sync(() => addon.notify({
      message: "Steamrip requires a Cloudflare captcha. Please solve it in the opened browser window.",
      id: "cloudflare-captcha",
      type: "warning",
    }));

    const visibleHeaders = yield* Effect.tryPromise({
      try: () => openSteamrip(url, "visible", 60),
      catch: (error) => new CloudflareTestError({ url, error }),
    });

    if (!visibleHeaders) {
      yield* Effect.sync(() => addon.notify({
        message: "Failed to solve the Cloudflare captcha.",
        id: "cloudflare-captcha",
        type: "error",
      }));
      throw new Error("Failed to open Steamrip after the Cloudflare captcha");
    }

    headerManager.requiresCloudflare = hasCloudflareCookies(visibleHeaders.cookies);
    yield* headerManager.setHeaders(visibleHeaders);
    return visibleHeaders;
  });
