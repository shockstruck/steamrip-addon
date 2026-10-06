import { isFilecryptUrl } from "../filecrypt";
import { DLService } from "./BaseService";
import BzzhrService from "./Bzzhr";
import FichierService from "./1Fichier";
import FileCryptService from "./FileCrypt";
import GofileService from "./Gofile";
import PixelDrainService from "./PixelDrain";
import MegaDBService from "./MegaDB";
import UnknownService from "./Unknown";
import { Effect } from "effect";
import { InvalidUrlError } from "../errors";

export type DownloadLink = { url: string };

const ROMAN_NUMERALS = new Map(
  [
    "i",
    "ii",
    "iii",
    "iv",
    "v",
    "vi",
    "vii",
    "viii",
    "ix",
    "x",
    "xi",
    "xii",
    "xiii",
    "xiv",
    "xv",
    "xvi",
    "xvii",
    "xviii",
    "xix",
    "xx",
  ].map((numeral, index) => [numeral, String(index + 1)]),
);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

// These labels commonly differ between Steam and SteamRIP without changing
// the underlying game. They still affect ranking when two editions exist.
const SOFT_QUALIFIERS = new Set([
  "complete",
  "definitive",
  "deluxe",
  "digital",
  "directorscut",
  "edition",
  "enhanced",
  "gold",
  "goty",
  "hd",
  "premium",
  "remake",
  "remaster",
  "remastered",
  "ultimate",
  "windows",
]);

// Applied when only one title carries a number. A trailing number is a
// sequel ("Portal 2"); an interior one is usually a naming difference.
const TRAILING_NUMBER_PENALTY = 0.75;
const INTERIOR_NUMBER_PENALTY = 0.9;

type NormalizedTitle = {
  tokens: string[];
  coreTokens: string[];
  qualifiers: string[];
  sequenceNumbers: string[];
};

const stripSteamRipMetadata = (title: string) =>
  title.replace(/\s+free\s+download\b.*$/i, "").trim();

const titleVariants = (title: string): string[] => {
  const cleanTitle = stripSteamRipMetadata(title);
  const variants = [cleanTitle];
  const aliases = cleanTitle.split(/\s*\/\s*/).filter(Boolean);

  if (aliases.length > 1) variants.push(...aliases);

  return [...new Set(variants)];
};

const normalizeTitle = (title: string): NormalizedTitle => {
  const prepared = title
    // NFKD would otherwise turn ™ into "TM" glued onto the preceding word.
    .replace(/[™®©℠]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[’'`]/g, "")
    .replace(/game\s+of\s+the\s+year/gi, " goty ")
    .replace(/directors?\s+cut/gi, " directorscut ")
    .replace(/&/g, " and ");

  const rawTokens = prepared.match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = rawTokens.map((rawToken, index) => {
    const token = rawToken.toLowerCase();
    const romanValue = ROMAN_NUMERALS.get(token);
    const wasUppercaseRoman =
      rawToken === rawToken.toUpperCase() &&
      rawToken !== rawToken.toLowerCase();

    // Avoid interpreting leading title words such as "I" or "V" in
    // "I Am Alive" and "V Rising" as sequel numbers.
    if (
      romanValue &&
      (rawToken.length > 1 || (wasUppercaseRoman && index > 0))
    ) {
      return romanValue;
    }

    return token;
  });

  const meaningfulTokens = tokens.filter((token) => !STOP_WORDS.has(token));
  const qualifiers = meaningfulTokens.filter((token) =>
    SOFT_QUALIFIERS.has(token),
  );
  const coreTokens = meaningfulTokens.filter(
    (token) => !SOFT_QUALIFIERS.has(token),
  );

  return {
    tokens,
    coreTokens,
    qualifiers,
    sequenceNumbers: coreTokens.filter((token) => /^\d+$/.test(token)),
  };
};

// Only the one-sided number penalty below needs word order: a number tucked
// between two other core words ("Yakuza 7 Like a Dragon") is a naming
// difference, while a trailing one ("Portal 2") is a different game.
const hasOnlyInteriorNumbers = (title: NormalizedTitle): boolean =>
  title.coreTokens.every(
    (token, index) =>
      !/^\d+$/.test(token) ||
      (title.coreTokens.slice(0, index).some((other) => !/^\d+$/.test(other)) &&
        title.coreTokens
          .slice(index + 1)
          .some((other) => !/^\d+$/.test(other))),
  );

const characterSimilarity = (left: string, right: string): number => {
  if (left === right) return 1;
  if (
    left.length < 4 ||
    right.length < 4 ||
    /^\d+$/.test(left) ||
    /^\d+$/.test(right)
  ) {
    return 0;
  }

  const bigrams = (value: string) => {
    const result = new Set<string>();
    for (let index = 0; index < value.length - 1; index++) {
      result.add(value.slice(index, index + 2));
    }
    return result;
  };

  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  const intersection = [...leftBigrams].filter((bigram) =>
    rightBigrams.has(bigram),
  ).length;

  return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
};

const tokenCoverage = (source: string[], target: string[]): number => {
  if (source.length === 0 || target.length === 0) return 0;

  const usedTargetTokens = new Set<number>();
  let matched = 0;

  for (const sourceToken of source) {
    let bestScore = 0;
    let bestIndex = -1;

    for (let index = 0; index < target.length; index++) {
      if (usedTargetTokens.has(index)) continue;

      const score = characterSimilarity(sourceToken, target[index]);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex !== -1 && bestScore >= 0.75) {
      usedTargetTokens.add(bestIndex);
      matched += bestScore;
    }
  }

  return matched / source.length;
};

const qualifierModifier = (
  leftQualifiers: string[],
  rightQualifiers: string[],
): number => {
  if (leftQualifiers.length === 0 && rightQualifiers.length === 0) return 1;

  const left = new Set(leftQualifiers);
  const right = new Set(rightQualifiers);
  const shared = [...left].filter((qualifier) => right.has(qualifier)).length;

  if (shared === left.size && shared === right.size) return 1;
  if (left.size === 0 || right.size === 0) return 0.9;
  if (shared === 0) return 0.82;
  return 0.94;
};

const scoreNormalizedTitles = (
  left: NormalizedTitle,
  right: NormalizedTitle,
): number => {
  if (left.tokens.join(" ") === right.tokens.join(" ")) return 1;
  if (left.coreTokens.length === 0 || right.coreTokens.length === 0) return 0;

  if (
    left.sequenceNumbers.length > 0 &&
    right.sequenceNumbers.length > 0 &&
    !left.sequenceNumbers.some((number) =>
      right.sequenceNumbers.includes(number),
    )
  ) {
    return 0;
  }

  const leftCoverage = tokenCoverage(left.coreTokens, right.coreTokens);
  const rightCoverage = tokenCoverage(right.coreTokens, left.coreTokens);
  if (leftCoverage === 0 || rightCoverage === 0) return 0;

  const minimumCoverage = Math.min(leftCoverage, rightCoverage);
  const harmonicCoverage =
    (2 * leftCoverage * rightCoverage) / (leftCoverage + rightCoverage);
  let score = minimumCoverage * 0.7 + harmonicCoverage * 0.3;

  if (
    (left.sequenceNumbers.length > 0) !==
    (right.sequenceNumbers.length > 0)
  ) {
    const numbered = left.sequenceNumbers.length > 0 ? left : right;
    score *= hasOnlyInteriorNumbers(numbered)
      ? INTERIOR_NUMBER_PENALTY
      : TRAILING_NUMBER_PENALTY;
  }

  return score * qualifierModifier(left.qualifiers, right.qualifiers);
};

export const stringSimilarity = (left: string, right: string): number => {
  let bestScore = 0;

  for (const leftVariant of titleVariants(left)) {
    const normalizedLeft = normalizeTitle(leftVariant);

    for (const rightVariant of titleVariants(right)) {
      bestScore = Math.max(
        bestScore,
        scoreNormalizedTitles(normalizedLeft, normalizeTitle(rightVariant)),
      );
    }
  }

  return bestScore;
};

function matchService(url: URL): DLService {
  const hostname = url.hostname.toLowerCase();
  const href = url.toString();

  if (isFilecryptUrl(href)) return new FileCryptService();
  if (hostname.includes("bzzhr")) return new BzzhrService();
  if (hostname.includes("1fichier")) return new FichierService();
  if (hostname.includes("gofile")) return new GofileService();
  if (hostname.includes("pixeldrain")) return new PixelDrainService();
  if (hostname.includes("megadb")) return new MegaDBService();
  if (hostname.includes("datanodes")) return new DLService("DataNodes", 0);
  return new UnknownService();
}

export const resolveServiceFromUrl = (url: string) =>
  Effect.gen(function* () {
    const urlObj = yield* Effect.try({
      try: () => new URL(url),
      catch: () => new InvalidUrlError({ url }),
    });
    return matchService(urlObj);
  });

export const rankDownloadLinks = (links: DownloadLink[]) =>
  Effect.gen(function* () {
    const ranked: { service: DLService; url: string }[] = [];
    for (const link of links) {
      const service = yield* resolveServiceFromUrl(link.url);
      if (service.priority > 0) {
        ranked.push({ service, url: link.url });
      }
    }
    ranked.sort((a, b) => {
      const aIsGofile = a.service.name === "Gofile";
      const bIsGofile = b.service.name === "Gofile";
      if (aIsGofile !== bIsGofile) return aIsGofile ? -1 : 1;
      return b.service.priority - a.service.priority;
    });
    return ranked;
  });
