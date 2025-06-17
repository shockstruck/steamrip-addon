import puppeteer from "puppeteer-extra";
import { DLService, PUPPETEER_OPTIONS } from "./BaseService";
import stealth from "puppeteer-extra-plugin-stealth";
import adblock from "puppeteer-extra-plugin-adblocker";
import { ElementHandle } from "puppeteer";

export default class PixelDrainService extends DLService {
  public constructor() {
    super('PixelDrain', 10);
  }

  async scrapeDownloadLinks(url: string): Promise<{ name: string; url: string; }[]> {
    puppeteer.use(stealth());
    puppeteer.use(adblock());

    const browser = await puppeteer.launch({
      ...PUPPETEER_OPTIONS,
      headless: false
    });
    const page = await browser.newPage();
    await page.goto(url);
    
    const downloadButtons = await page.$$('button.button_highlight');
    if (downloadButtons.length === 0) {
      throw new Error('No download button found');
    }
    // Make the search for the download button fully async
    let downloadButton: ElementHandle<HTMLButtonElement> | null = null;
    for (const button of downloadButtons) {
      const isDownload = await button.evaluate(el => {
        return Array.from(el.children).some(child => 
          child.tagName === 'I' && 
          child.className.includes('icon') && 
          child.textContent === 'download'
        );
      });
      if (isDownload) {
        downloadButton = button;
        break;
      }
    }
    console.log('found a download button');

    if (!downloadButton) {
      throw new Error('No download button found');
    }
    const downloadUrl = await this.downloadCatcher(page, downloadButton);
    if (!downloadUrl) {
      throw new Error('No download url found');
    }
    await browser.close();

    return [{ name: 'PIXELDRAIN', url: downloadUrl }];
  }
}