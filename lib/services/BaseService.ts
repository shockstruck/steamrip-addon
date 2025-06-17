import type { ElementHandle, Page } from "puppeteer";
import puppeteer, { type VanillaPuppeteer } from "puppeteer-extra";
export const PUPPETEER_OPTIONS: Parameters<VanillaPuppeteer["launch"]>[0] = {
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-sync",
    "--ignore-certificate-errors",
    "--lang=en-US,en;q=0.9",
  ],
  defaultViewport: { width: 1366, height: 768 }
}

export class DLService {
  public name: string;
  public priority: number;
  public constructor(name: string, priority: number) {
    this.name = name;
    this.priority = priority;
  }
  async scrapeDownloadLinks(url: string): Promise<{ name: string, url: string }[]> {
    throw new Error('Not implemented');
  }

  async downloadCatcher(page: Page, downloadButton: ElementHandle<Element>) {
    const downloadUrl = await new Promise<string | undefined>(async (resolve, reject) => {
      await downloadButton.click();
      console.log('clicked download button');
      const cdp = await page.createCDPSession();
      console.log('created cdp session');
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: '/tmp',
        eventsEnabled: true,
      });
      cdp.on('Browser.downloadWillBegin', async (event) => {
        console.log(event.url);
        // cancel the download
        await cdp.send('Browser.cancelDownload', {
          guid: event.guid,
        });

        resolve(event.url);
      });
      console.log('waiting for download to begin');
      // wait 5 seconds, and if not resolved, reject
      setTimeout(() => {
        resolve(undefined);
      }, 5000);
    });

    return downloadUrl;
  }
}
