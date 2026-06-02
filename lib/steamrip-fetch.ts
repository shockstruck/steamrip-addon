import axios, { type AxiosResponse } from "axios";
import { Effect } from "effect";
import { headerManager } from "./header-manager";
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

async function fetchSteamripHtmlWithBrowser(url: string): Promise<string> {
  const { browser, page } = await connectRealBrowser({ headless: true, disableXvfb: true });

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

    const html = await activePage.content();
    if (isCloudflareChallenge(200, {}, html)) {
      const title = await activePage.title().catch(() => "unknown");
      const currentUrl = activePage.url();
      throw new Error(`Cloudflare challenge page returned while fetching steamrip content (title=${title}, url=${currentUrl}, cookies=${cookies.length})`);
    }

    return html;
  } finally {
    await browser.close().catch(() => undefined);
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
    yield* headerManager.loadHeaders();

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
