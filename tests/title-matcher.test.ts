import { describe, expect, it } from "bun:test";
import { stringSimilarity } from "../lib/services/matcher";

type CatalogGame = { name: string; url: string };

const catalog = (await Bun.file("catalog.json").json()) as {
  games: CatalogGame[];
};

const bestCatalogMatch = (title: string) => {
  let bestMatch: CatalogGame | undefined;
  let bestScore = 0;

  for (const game of catalog.games) {
    const score = stringSimilarity(game.name, title);
    if (score > bestScore) {
      bestMatch = game;
      bestScore = score;
    }
  }

  return { game: bestMatch, score: bestScore };
};

describe("Steam title matching", () => {
  it.each([
    ["Hades II", "Hades 2 Free Download (v1.138464)"],
    ["DARK SOULS™ III", "DARK SOULS III Free Download (v1.15.2)"],
    [
      "Sid Meier’s Civilization® VI",
      "Sid Meier’s Civilization VI Free Download (v1.0.12.58)",
    ],
    ["Baldur's Gate 3", "Baldur’s Gate 3 Free Download (v4.1.1.6995620)"],
    ["Portal", "Portal Free Download (Build 18647097)"],
    ["Portal 2", "Portal 2 Free Download (Build 8201171)"],
    ["DOOM", "DOOM Free Download (v6.66_Update 9)"],
    ["DOOM Eternal", "DOOM Eternal Free Download (Build 22500424)"],
    [
      "Grand Theft Auto V",
      "Grand Theft Auto V / GTA 5 Free Download (v1.0.3751.0/1.72)",
    ],
    ["Resident Evil 4", "Resident Evil 4 Remake Free Download (Build 22377325)"],
  ])("matches %s to the expected SteamRIP entry", (steamTitle, expected) => {
    const match = bestCatalogMatch(steamTitle);

    expect(match.score).toBeGreaterThanOrEqual(0.6);
    expect(match.game?.name).toBe(expected);
  });

  it.each([
    ["Hades II", "Hades Free Download (Build 10929685)"],
    ["Portal", "Portal 2 Free Download (Build 8201171)"],
    ["DOOM", "DOOM Eternal Free Download (Build 22500424)"],
    ["FINAL FANTASY VI", "FINAL FANTASY V Free Download"],
  ])("rejects %s as %s", (steamTitle, catalogTitle) => {
    expect(stringSimilarity(steamTitle, catalogTitle)).toBeLessThan(0.6);
  });

  it("allows SteamRIP-only edition labels without losing the base game", () => {
    expect(
      stringSimilarity(
        "Control",
        "Control Ultimate Edition Free Download (v0.0.517.915)",
      ),
    ).toBeGreaterThanOrEqual(0.6);
  });

  it("normalizes lowercase multi-character Roman numerals", () => {
    expect(stringSimilarity("Hades ii", "Hades 2 Free Download")).toBe(1);
  });

  it.each(["V Rising", "I Am Alive"])(
    "does not treat a leading single-letter title in %s as a sequel",
    (title) => {
      expect(stringSimilarity(title, `${title} Free Download`)).toBe(1);
    },
  );
});
