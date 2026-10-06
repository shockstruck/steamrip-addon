import { describe, expect, it } from "bun:test";
import { stringSimilarity } from "../lib/services/matcher";

// Pure pairs: no catalog.json and no network.
const THRESHOLD = 0.6;

describe("title matcher false negatives", () => {
  it.each([
    ["Yakuza: Like a Dragon", "Yakuza 7 Like a Dragon Free Download"],
    ["Resident Evil Village", "Resident Evil 8 Village Free Download"],
    ["Crysis Remastered", "Crysis Free Download"],
    ["Crysis", "Crysis Remastered Free Download"],
    ["Resident Evil 4", "Resident Evil 4 Remake Free Download (Build 1)"],
    ["Wolfenstein HD", "Wolfenstein Free Download"],
    ["Star Wars™ Jedi", "Star Wars Jedi Free Download"],
    ["The Last of Us™ Part I", "The Last of Us Part I Free Download"],
    ["Marvel’s Spider-Man®", "Marvel’s Spider-Man Free Download"],
  ])("matches %s to %s", (steamTitle, catalogTitle) => {
    const score = stringSimilarity(steamTitle, catalogTitle);
    console.log(score.toFixed(3), steamTitle, "|", catalogTitle);
    expect(score).toBeGreaterThanOrEqual(THRESHOLD);
  });

  it("strips trademark marks before tokenising", () => {
    expect(stringSimilarity("Us™", "Us Free Download")).toBe(1);
  });
});

describe("title matcher rejections stay rejected", () => {
  it.each([
    ["Hades", "Hades II Free Download"],
    ["Hades II", "Hades Free Download"],
    ["Portal", "Portal 2 Free Download"],
    ["Portal 2", "Portal Free Download"],
    ["DOOM", "DOOM Eternal Free Download"],
    ["DOOM Eternal", "DOOM Free Download"],
    ["FINAL FANTASY VI", "FINAL FANTASY V Free Download"],
    ["Resident Evil", "Resident Evil 2 Free Download"],
    ["Resident Evil 2", "Resident Evil Free Download"],
    ["Fallout", "Fallout 4 Free Download"],
    ["Mass Effect", "Mass Effect 3 Free Download"],
  ])("rejects %s as %s", (steamTitle, catalogTitle) => {
    const score = stringSimilarity(steamTitle, catalogTitle);
    console.log(score.toFixed(3), steamTitle, "|", catalogTitle);
    expect(score).toBeLessThan(THRESHOLD);
  });
});
