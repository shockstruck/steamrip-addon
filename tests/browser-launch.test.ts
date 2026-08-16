import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  connectRealBrowser,
  isBlankBrowserPageUrl,
  navigateBrowserPage,
  normalizeBrowserArgs,
  pickPrimaryBrowserPage,
  resolveBrowserExecutablePath,
  resolveFlatpakChromiumExecutablePath,
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
        () => undefined,
      ),
    ).toBe("/usr/bin/chromium-browser");
  });

  it("uses the Flatpak Chromium launcher on Linux", () => {
    const launcherPath = "/addon/scripts/launch-flatpak-chromium.sh";
    const calls: string[][] = [];

    const executablePath = resolveFlatpakChromiumExecutablePath(
      (_executable, args) => {
        calls.push([...args]);
        return "installed";
      },
      path => path === launcherPath,
      launcherPath,
    );

    expect(executablePath).toBe(launcherPath);
    expect(calls).toEqual([
      ["info", "--system", "org.chromium.Chromium"],
    ]);

    expect(
      resolveBrowserExecutablePath(
        "linux",
        "x64",
        {},
        path => path === launcherPath,
        () => executablePath,
      ),
    ).toBe(launcherPath);
  });

  it("falls back to a user Flatpak Chromium installation", () => {
    const launcherPath = "/addon/scripts/launch-flatpak-chromium.sh";
    const calls: string[][] = [];
    const executablePath = resolveFlatpakChromiumExecutablePath(
      (_executable, args) => {
        calls.push([...args]);
        if (args.includes("--system")) throw new Error("not installed");
        return "installed";
      },
      () => true,
      launcherPath,
    );

    expect(executablePath).toBe(launcherPath);
    expect(calls.map(args => args[1])).toEqual(["--system", "--user"]);
  });

  it("launches Chromium through Flatpak with host tmp access", () => {
    const toolsPath = mkdtempSync(join(tmpdir(), "steamrip-flatpak-test-"));
    const fakeFlatpakPath = join(toolsPath, "flatpak");
    writeFileSync(
      fakeFlatpakPath,
      '#!/bin/sh\nif [ "$1" = "info" ]; then exit 0; fi\nprintf \'%s\\n\' "$@"\n',
    );
    chmodSync(fakeFlatpakPath, 0o755);

    try {
      const launcherPath = fileURLToPath(
        new URL("../scripts/launch-flatpak-chromium.sh", import.meta.url),
      );
      const result = spawnSync(
        launcherPath,
        ["--remote-debugging-port=9222", "--user-data-dir=/tmp/profile"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${toolsPath}:${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        "run",
        "--system",
        "--filesystem=/tmp",
        "--command=chromium",
        "org.chromium.Chromium",
        "--remote-debugging-port=9222",
        "--user-data-dir=/tmp/profile",
      ]);
    } finally {
      rmSync(toolsPath, { recursive: true, force: true });
    }
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

  it("forwards the discovered Chromium path to chrome-launcher", async () => {
    const originalChromePath = process.env.CHROME_PATH;
    let launchOptions: Record<string, unknown> | undefined;
    const page = new FakePage("about:blank");

    process.env.CHROME_PATH = "/bin/sh";
    try {
      await connectRealBrowser(
        { headless: true, disableXvfb: true },
        async options => {
          launchOptions = options as unknown as Record<string, unknown>;
          return {
            browser: { pages: async () => [page] },
            page,
          } as never;
        },
      );
    } finally {
      if (originalChromePath === undefined) {
        delete process.env.CHROME_PATH;
      } else {
        process.env.CHROME_PATH = originalChromePath;
      }
    }

    expect(launchOptions).toMatchObject({
      customConfig: {
        chromePath: "/bin/sh",
      },
    });
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
