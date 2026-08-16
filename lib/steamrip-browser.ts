export type SteamripBrowserMode = "background" | "visible";

export interface SteamripBrowserLaunchOptions {
  headless: boolean;
  turnstile: boolean;
  disableXvfb: boolean;
}

export function getSteamripBrowserLaunchOptions(
  mode: SteamripBrowserMode,
  platform: NodeJS.Platform = process.platform,
): SteamripBrowserLaunchOptions {
  if (mode === "visible") {
    return { headless: false, turnstile: true, disableXvfb: true };
  }

  if (platform === "linux") {
    return { headless: false, turnstile: true, disableXvfb: false };
  }

  return { headless: true, turnstile: false, disableXvfb: true };
}
