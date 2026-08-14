import { describe, expect, it } from "bun:test";
import {
  isBlankBrowserPageUrl,
  navigateBrowserPage,
  normalizeBrowserArgs,
  pickPrimaryBrowserPage,
  resolveBrowserExecutablePath,
  STEAMRIP_REFERER,
  type BrowserPageLike,
  type NavigablePageLike,
} from "../lib/services/BaseService";

class FakePage implements BrowserPageLike {
  constructor(
    private readonly currentUrl: string,
    private readonly closed = false
  ) {}

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

class FakeNavigablePage implements NavigablePageLike {
  private currentUrl = "about:blank";
  public navigationOptions: Parameters<NavigablePageLike["goto"]>[1];

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return false;
  }

  async goto(
    url: string,
    options?: Parameters<NavigablePageLike["goto"]>[1],
  ): Promise<unknown> {
    this.currentUrl = url;
    this.navigationOptions = options;
    return undefined;
  }
}

describe("browser launch helpers", () => {
  it("removes minimized launch flags for visible browsers", () => {
    expect(
      normalizeBrowserArgs(
        ["--start-minimized", "--lang=en-US,en;q=0.9", "--start-minimized"],
        { headless: false }
      )
    ).toEqual(["--lang=en-US,en;q=0.9"]);
  });

  it("keeps minimized launch flags for headless browsers", () => {
    expect(
      normalizeBrowserArgs(["--start-minimized", "--lang=en-US,en;q=0.9"], {
        headless: true,
      })
    ).toEqual(["--start-minimized", "--lang=en-US,en;q=0.9"]);
  });

  it("treats Chromium blank tabs as blank pages", () => {
    expect(isBlankBrowserPageUrl("about:blank")).toBe(true);
    expect(isBlankBrowserPageUrl("chrome://newtab/")).toBe(true);
    expect(isBlankBrowserPageUrl("chrome-search://local-ntp/local-ntp.html")).toBe(true);
    expect(isBlankBrowserPageUrl("https://steamrip.com")).toBe(false);
  });

  it("prefers a real page over a blank fallback tab", () => {
    const blankPage = new FakePage("about:blank");
    const realPage = new FakePage("https://steamrip.com");

    expect(pickPrimaryBrowserPage([blankPage, realPage], blankPage)).toBe(realPage);
  });

  it("uses a system Chromium binary on Linux ARM instead of Puppeteer's x64 cache", () => {
    const existing = new Set(["/usr/bin/chromium-browser"]);
    expect(
      resolveBrowserExecutablePath(
        "linux",
        "arm64",
        {},
        path => existing.has(path),
      ),
    ).toBe("/usr/bin/chromium-browser");
  });

  it("prefers an explicitly configured Chrome path", () => {
    expect(
      resolveBrowserExecutablePath(
        "linux",
        "arm64",
        { CHROME_PATH: "/custom/chrome" },
        path => path === "/custom/chrome",
      ),
    ).toBe("/custom/chrome");
  });

  it("opens provider pages with SteamRIP as the referer", async () => {
    const page = new FakeNavigablePage();
    const browser = {
      pages: async () => [page],
    };

    await navigateBrowserPage(browser, page, "https://megadb.example/file", {
      waitUntil: "domcontentloaded",
    });

    expect(page.navigationOptions).toMatchObject({
      referer: STEAMRIP_REFERER,
      waitUntil: "domcontentloaded",
    });
  });
});
