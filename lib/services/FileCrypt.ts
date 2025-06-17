import { DLService } from "./BaseService";
import { isFilecryptUrl, processFilecryptUrl } from "../filecrypt";

export default class FileCryptService extends DLService {
  public constructor() {
    super('FileCrypt', 8); // High priority since it's a link redirector
  }

  async scrapeDownloadLinks(url: string): Promise<{ name: string; url: string; }[]> {
    if (!isFilecryptUrl(url)) {
      throw new Error(`URL is not a FileCrypt URL: ${url}`);
    }

    console.log(`[FileCrypt] Processing URL: ${url}`);
    
    try {
      const finalUrl = await processFilecryptUrl(url, {
        headless: false, // Keep it headless as requested
        redirectTimeout: 60000 // 60 second timeout for automatic redirect
      });

      return [{ 
        name: 'FILECRYPT_REDIRECT', 
        url: finalUrl 
      }];

    } catch (error) {
      console.error(`[FileCrypt] Error processing URL: ${error}`);
      throw error;
    }
  }
} 