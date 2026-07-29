import { describe, expect, it } from "bun:test";
import BzzhrService, {
  getBzzhrNavigationOptions,
} from "../lib/services/Bzzhr";

describe("Bzzhr navigation", () => {
  it("ranks below Gofile but above lower-priority fallbacks", () => {
    expect(new BzzhrService().priority).toBe(8);
  });

  it("supplies the SteamRIP referrer required by Bzzhr file pages", () => {
    expect(getBzzhrNavigationOptions()).toMatchObject({
      referer: "https://steamrip.com/",
    });
  });
});
