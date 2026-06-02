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
