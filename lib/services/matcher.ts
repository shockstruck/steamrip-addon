import type { DLService } from "./BaseService";
import { isFilecryptUrl } from "../filecrypt";
import { getLinks } from "../../tests/scraper.test";
import BuzzheavierService from "./BuzzHeavier";
import FichierService from "./1Fichier";
import FileCryptService from "./FileCrypt";
import GofileService from "./Gofile";
import { Effect } from "effect";
import { InvalidUrlError, NoServiceFoundError, UnknownServiceError } from "../errors";
import PixelDrainService from "./PixelDrain";

export const getService = (name: string) => Effect.gen(function*() {
  switch (name) {
    case 'Buzzheavier':
      return yield* Effect.succeed(new BuzzheavierService());
    case 'Fichier':
      return yield* Effect.succeed(new FichierService());
    case 'FileCrypt':
      return yield* Effect.succeed(new FileCryptService());
    case 'Gofile':
      return yield* Effect.succeed(new GofileService());
    case 'PixelDrain':
      return yield* Effect.succeed(new PixelDrainService());
    default:
      return yield* Effect.fail(new UnknownServiceError({ name }));
  }
});

/**
 * Detects the appropriate service based on the URL
 */
export const detectServiceFromUrl = (url: string) => Effect.gen(function* () {
  const urlObj = yield* Effect.try({
    try: () => new URL(url),
    catch: () => new InvalidUrlError({ url })
  });
  const hostname = urlObj.hostname.toLowerCase();

  // Check for FileCrypt
  if (isFilecryptUrl(url)) {
    return yield* Effect.succeed(new FileCryptService());
  }

  // Check for other services based on hostname
  if (hostname.includes('buzzheavier')) {
    return yield* Effect.succeed(new BuzzheavierService());
  }

  if (hostname.includes('1fichier')) {
    return yield* Effect.succeed(new FichierService());
  }

  if (hostname.includes('gofile')) {
    return yield* Effect.succeed(new GofileService());
  }
  
  return yield* Effect.fail(new NoServiceFoundError());
});

/**
 * Gets the service name from a URL
 */
export function getServiceNameFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    // Check for FileCrypt
    if (isFilecryptUrl(url)) {
      return 'FileCrypt';
    }

    // Check for other services based on hostname
    if (hostname.includes('buzzheavier')) {
      return 'Buzzheavier';
    }

    if (hostname.includes('1fichier')) {
      return 'Fichier';
    }

    if (hostname.includes('gofile')) {
      return 'Gofile';
    }
    if (hostname.includes('pixeldrain')) {
      return 'PixelDrain';
    }
    
    return null;
  } catch {
    return null;
  }
}