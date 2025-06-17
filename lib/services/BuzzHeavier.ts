import axios from "axios";
import { JSDOM } from "jsdom";
import { DLService, PUPPETEER_OPTIONS } from "./BaseService";
import puppeteer from "puppeteer-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import adblock from "puppeteer-extra-plugin-adblocker";
import type { Browser } from "puppeteer";
import * as fs from "fs/promises";

export default class BuzzheavierService extends DLService {
  public constructor() {
    super('Buzzheavier', 10);
  }
  async scrapeDownloadLinks(url: string) {
    console.log('scraping download links');
    const browser: Browser = await puppeteer.launch(PUPPETEER_OPTIONS);
    const page = await browser.newPage();
    await page.goto(url);
    await page.evaluate(() => { (window as any).adLink = null; });
    await page.waitForSelector('.link-button.gay-button');
    // there are going to be 2 buttons, one for the download and one for previewing. we need to click the download button.
    // we can do this by getting the hx-get attribute and seeing if it contains the word "download"
    const potentialButtons = await page.$$('.link-button.gay-button');
    const downloadButton = potentialButtons.find(button => button.evaluate(el => el.getAttribute('hx-get')?.includes('download')));
    if (!downloadButton) {
      console.log('uh oh')
      throw new Error('No download button found');
    }

    await page.screenshot({ path: 'page.png' });

    const downloadUrl = await new Promise<string | undefined>(async (resolve, reject) => {
      await downloadButton.click();
      const cdp = await page.createCDPSession();
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

      // wait 5 seconds, and if not resolved, reject
      setTimeout(() => {
        resolve(undefined);
      }, 5000);
    });
    if (!downloadUrl) {
      throw new Error('No download url found');
    }
    await browser.close();
    return [{
      url: downloadUrl,
      name: 'Buzzheavier',
    }];
  }
}