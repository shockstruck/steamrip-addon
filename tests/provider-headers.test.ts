import { describe, expect, it } from "bun:test";
import {
  STEAMRIP_REFERER,
  withSteamripReferer,
} from "../lib/services/BaseService";

describe("provider download headers", () => {
  it("uses SteamRIP as the referer for every final download", () => {
    expect(withSteamripReferer({ Authorization: "Bearer token" })).toEqual({
      Authorization: "Bearer token",
      Referer: STEAMRIP_REFERER,
    });
  });

  it("replaces provider referers regardless of header casing", () => {
    expect(
      withSteamripReferer({
        referer: "https://gofile.io/",
        Cookie: "accountToken=token",
      }),
    ).toEqual({
      Cookie: "accountToken=token",
      Referer: STEAMRIP_REFERER,
    });
  });
});
