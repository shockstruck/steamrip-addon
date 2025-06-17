import type { DLService } from "./BaseService";
import { isFilecryptUrl } from "../filecrypt";
import { getLinks } from "../../tests/scraper.test";
import BuzzheavierService from "./BuzzHeavier";
import FichierService from "./1Fichier";
import FileCryptService from "./FileCrypt";
import GofileService from "./Gofile";

export function getService(name: string): DLService {
  switch (name) {
    case 'Buzzheavier':
      return new BuzzheavierService();
    case 'Fichier':
      return new FichierService();
    case 'FileCrypt':
      return new FileCryptService();
    default:
      throw new Error(`Unknown service: ${name}`);
  }
}

/**
 * Detects the appropriate service based on the URL
 */
export function detectServiceFromUrl(url: string): DLService | null {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    // Check for FileCrypt
    if (isFilecryptUrl(url)) {
      return new FileCryptService();
    }

    // Check for other services based on hostname
    if (hostname.includes('buzzheavier')) {
      return new BuzzheavierService();
    }

    if (hostname.includes('1fichier')) {
      return new FichierService();
    }

    if (hostname.includes('gofile')) {
      return new GofileService();
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Gets the service name from a URL
 */
export function getServiceNameFromUrl(url: string): string | null {
  const service = detectServiceFromUrl(url);
  return service?.name || null;
}