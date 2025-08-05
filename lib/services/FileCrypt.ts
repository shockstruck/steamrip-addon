import { DLService } from "./BaseService";
import { isFilecryptUrl, processFilecryptUrl } from "../filecrypt";
import { Effect } from "effect";
import { FileCryptError, FileCryptUrlError } from "../errors";
import { ConfigurationBuilder, type EventResponse, type SearchResult } from "ogi-addon";

export default class FileCryptService extends DLService {
  public constructor() {
    super('FileCrypt', 6); // low priority since it's a link redirector
  }

  isCaptchaBased(): boolean {
    return true;
  }

  scrapeDownloadLinks(url: string, event: EventResponse<SearchResult>): Effect.Effect<{ name: string; url: string; headers: Record<string, string> }[], Error> {
    return Effect.gen(function*() {
      yield* Effect.promise(() => event.askForInput(
        'Captcha Notice',
        'The site you are about to access requires a captcha to be solved. A browser window will open to solve it. Once solved, click on the download link and our system should detect completion and close the window.',
        new ConfigurationBuilder())
      );

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
        url: finalUrl,
        headers: {}
      }];
    });
  }
} 