import { DLService } from "./BaseService";
import { isFilecryptUrl, processFilecryptUrl } from "../filecrypt";
import { Effect } from "effect";
import { FileCryptError, FileCryptUrlError } from "../errors";

export default class FileCryptService extends DLService {
  public constructor() {
    super('FileCrypt', 8); // High priority since it's a link redirector
  }

  scrapeDownloadLinks(url: string) {
    return Effect.gen(function*() {
      if (!isFilecryptUrl(url)) {
        return yield* Effect.fail(new FileCryptUrlError({ url }));
      }

      console.log(`[FileCrypt] Processing URL: ${url}`);
      
      const finalUrl = yield* processFilecryptUrl(url, { headless: false, redirectTimeout: 60000 }).pipe(
        Effect.catchTags({
          FileCryptUrlError: (e: FileCryptUrlError) => {
            return Effect.fail(e);
          }
        })
      );

      return [{ 
        name: 'FILECRYPT_REDIRECT', 
        url: finalUrl
      }];
    });
  }
} 