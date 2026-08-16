import axios, { type AxiosResponse } from "axios";
import { Effect } from "effect";
import { convertPuppeteerCookies, headerManager } from "./header-manager";
import { NetworkError } from "./errors";
import { connectRealBrowser, navigateBrowserPage } from "./services/BaseService";

export function isCloudflareChallenge(
  status: number,
  headers: Record<string, unknown> = {},
  body?: string,
): boolean {
  if (status === 403 || status === 503) {
    return true;
  }

  const mitigated = headers["cf-mitigated"] ?? headers["Cf-Mitigated"];
  if (mitigated === "challenge") {
    return true;
  }

  if (!body) {
    return false;
  }

  return (
    body.includes("Just a moment") ||
    body.includes("Checking your browser") ||
    (body.includes("Cloudflare") && body.includes("challenge"))
  );
}

function applySteamripRequestHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    Referer: "https://steamrip.com/",
    "Sec-Fetch-Site": "same-origin",
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSteamripChallengeToClear(page: any, timeoutMs = 90_000): Promise<string> {
  const startedAt = Date.now();
  let lastTitle = "unknown";
  let lastUrl = page.url?.() ?? "unknown";

  while (Date.now() - startedAt < timeoutMs) {
    const html = await page.content();
    if (!isCloudflareChallenge(200, {}, html)) {
      return html;
    }

    lastTitle = await page.title().catch(() => lastTitle);
    lastUrl = page.url?.() ?? lastUrl;
    await sleep(1_000);
  }

  const cookieCount = await page.cookies().then((cookies: unknown[]) => cookies.length).catch(() => 0);
  throw new Error(`Cloudflare challenge page returned while fetching steamrip content (title=${lastTitle}, url=${lastUrl}, browserCookies=${cookieCount})`);
}

async function fetchSteamripHtmlWithBrowserMode(
  url: string,
  headless: boolean,
  challengeTimeoutMs: number,
): Promise<string> {
  const { browser, page } = await connectRealBrowser({ headless, turnstile: !headless, disableXvfb: true });

  try {
    const headerData = headerManager.getHeaders();
    const cookies = headerManager.getCookies().map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain?.startsWith(".") ? cookie.domain : (cookie.domain ?? ".steamrip.com"),
      path: cookie.path ?? "/",
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite as any,
    }));

    console.log(`Steamrip browser fetch using ${cookies.length} stored cookie(s): ${url}`);
    if (cookies.length > 0) {
      await page.setCookie(...cookies).catch((error) => {
        console.warn("Failed to inject stored Steamrip cookies into browser", error);
      });
    }

    if (headerData.userAgent) {
      await page.setUserAgent(headerData.userAgent).catch(() => undefined);
    }

    const activePage = await navigateBrowserPage(browser as any, page as any, url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const html = await waitForSteamripChallengeToClear(activePage, challengeTimeoutMs);

    const steamripCookies = await activePage.cookies().then((allCookies: any[]) =>
      allCookies.filter((cookie) => cookie.domain?.includes("steamrip.com")),
    ).catch(() => []);
    if (steamripCookies.length > 0) {
      await Effect.runPromise(headerManager.setCookies(convertPuppeteerCookies(steamripCookies))).catch(() => undefined);
    }

    return html;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function fetchSteamripHtmlWithBrowser(url: string): Promise<string> {
  try {
    return await fetchSteamripHtmlWithBrowserMode(url, true, 7_000);
  } catch (error) {
    console.log("Headless Steamrip fetch was blocked, opening a visible browser:", error);
    return await fetchSteamripHtmlWithBrowserMode(url, false, 90_000);
  }
}

async function fetchSteamripHtmlWithAxios(url: string): Promise<AxiosResponse<string>> {
  return axios.get(url, {
    headers: applySteamripRequestHeaders(headerManager.getHeaderObject()),
    timeout: 30_000,
    maxRedirects: 5,
    validateStatus: () => true,
    responseType: "text",
  });
}

export function fetchSteamripHtml(url: string): Effect.Effect<string, NetworkError> {
  return Effect.gen(function* () {
    yield* headerManager.loadHeaders().pipe(Effect.catchAll(() => Effect.void));

    const axiosResponse = yield* Effect.tryPromise({
      try: () => fetchSteamripHtmlWithAxios(url),
      catch: (error) => new NetworkError({ url, error }),
    });

    if (
      axiosResponse.status >= 200 &&
      axiosResponse.status < 300 &&
      !isCloudflareChallenge(axiosResponse.status, axiosResponse.headers, axiosResponse.data)
    ) {
      return axiosResponse.data;
    }

    if (isCloudflareChallenge(axiosResponse.status, axiosResponse.headers, axiosResponse.data)) {
      console.log(`Steamrip axios fetch blocked (${axiosResponse.status}), retrying with browser: ${url}`);
    }

    return yield* Effect.tryPromise({
      try: () => fetchSteamripHtmlWithBrowser(url),
      catch: (error) => {
        console.error(`Steamrip browser fetch failed: ${url}`, error);
        return new NetworkError({ url, error });
      },
    });
  });
}
