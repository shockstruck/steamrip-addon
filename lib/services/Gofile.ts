import puppeteer from "puppeteer-extra";
import { DLService, PUPPETEER_OPTIONS } from "./BaseService";
import stealth from "puppeteer-extra-plugin-stealth";
import adblock from "puppeteer-extra-plugin-adblocker";

export default class GofileService extends DLService {
  public constructor() {
    super('Gofile', 10);
  }

  async scrapeDownloadLinks(url: string): Promise<{ name: string, url: string }[]> {
    puppeteer.use(stealth());
    puppeteer.use(adblock());
    const browser = await puppeteer.launch({
      ...PUPPETEER_OPTIONS,
      headless: false
    });
    const page = await browser.newPage();
    
    try {
      await page.goto(url, { waitUntil: 'networkidle2' });
      
      // Wait for the file manager to load
      await page.waitForSelector('#filemanager_itemslist', { timeout: 10000 });
      
      // Check if password is required
      const passwordForm = await page.$('#filemanager_alert_passwordform');
      if (passwordForm) {
        const isVisible = await page.evaluate(el => !el.classList.contains('hidden'), passwordForm);
        if (isVisible) {
          throw new Error('Password required for this Gofile link');
        }
      }
      
      // Wait for file items to load
      await page.waitForSelector('.item_download', { timeout: 5000 });
      
      // Extract file information and download links
      const downloadResults: { name: string, url: string }[] = [];
      
      // Get all file items with their names and download buttons
      const fileItems = await page.evaluate(() => {
        const items: { name: string, downloadButtonIndex: number }[] = [];
        const fileElements = document.querySelectorAll('[data-item-id]');
        
        fileElements.forEach((element, index) => {
          // Find the file name
          const nameElement = element.querySelector('.item_open') as HTMLElement;
          if (nameElement) {
            const fileName = nameElement.textContent?.trim() || `file_${index}`;
            const downloadButton = element.querySelector('.item_download');
            if (downloadButton) {
              items.push({ name: fileName, downloadButtonIndex: index });
            }
          }
        });
        
        return items;
      });
      
      // Process each file item
      for (const fileItem of fileItems) {
        try {
          // Find the corresponding download button
          const downloadButtons = await page.$$('.item_download');
          if (downloadButtons[fileItem.downloadButtonIndex]) {
            const downloadUrl = await this.downloadCatcher(page, downloadButtons[fileItem.downloadButtonIndex]);
            
            if (downloadUrl) {
              downloadResults.push({
                name: fileItem.name,
                url: downloadUrl
              });
            }
          }
        } catch (error) {
          console.warn(`Failed to process file ${fileItem.name}:`, error);
        }
      }
      return downloadResults;
      
    } catch (error) {
      throw new Error(`Failed to scrape Gofile: ${error}`);
    } finally {
      await browser.close();
    }
  }
}