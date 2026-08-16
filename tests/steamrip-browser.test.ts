import { describe, expect, it } from "bun:test";
import { getSteamripBrowserLaunchOptions } from "../lib/steamrip-browser";

describe("Steamrip browser mode", () => {
  it("runs the Linux background check headfully inside hidden Xvfb", () => {
    expect(getSteamripBrowserLaunchOptions("background", "linux")).toEqual({
      headless: false,
      turnstile: true,
      disableXvfb: false,
    });
  });

  it("only disables Xvfb for the visible fallback", () => {
    expect(getSteamripBrowserLaunchOptions("visible", "linux")).toEqual({
      headless: false,
      turnstile: true,
      disableXvfb: true,
    });
  });
});
