/*
* This file is used to test the scraper and services.
* All links must be provided in the LINKS.txt file.
* We do not provide any links, you must find them yourself to test the scraper.
*/

import Scraper from '../lib/scraper';
import { describe, it, expect } from 'bun:test';
import BuzzHeavierService from '../lib/services/BuzzHeavier';
import puppeteer from 'puppeteer-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import adblock from 'puppeteer-extra-plugin-adblocker';

puppeteer.use(stealth());
puppeteer.use(adblock());

type ValidLink = 'steamrip' | 'buzzheavier' | '1fichier' | 'pixeldrain' | 'gofile' | 'filecrypt-test';
export async function getLinks() {
  // get links from LINKS.txt

  const links = (await Bun.file('./tests/LINKS.txt').text()).split('\n').map(line => line.trim());
  const linksMap: Record<ValidLink, string> = { ...links.map(line => {
    const [service, url] = line.split(' ');
    return { [service]: url };
  }).reduce((acc, curr) => ({ ...acc, ...curr }), {}) as Record<ValidLink, string> };
  return linksMap;
}

const linksMap = await getLinks();

describe('Steamrip', () => {
  it('can scrape all links and provide the correct values', async () => {
    const scraper = new Scraper();
    const links = await scraper.scrapeAllLinks();
    expect(links).toBeDefined();
    expect(links.length).toBeGreaterThan(0);

    expect(links).toContainValue({
      name: "Half-Life Free Download",
      url: "https://steamrip.com/half-life-free-download-m1/"
    });
  });

  it('can scrape game downloads and provide the correct values', async () => {
    const scraper = new Scraper();
    const links = await scraper.scrapeGameDownloads(linksMap.steamrip);
    expect(links).toBeDefined();
    expect(links.length).toBeGreaterThan(0);
  });
});

describe('Buzzheavier', () => {
  it('can scrape download links', async () => {
    const service = new BuzzHeavierService();
    const links = await service.scrapeDownloadLinks(linksMap.buzzheavier);
    expect(links).toBeDefined();
    expect(links.length).toBeGreaterThan(0);

    console.log(links);
    expect(links).toContainEqual({
      name: "BUZZHEAVIER",
      url: expect.any(String)
    });
  }, Number.MAX_SAFE_INTEGER);
});
import FichierService from '../lib/services/1Fichier';
import PixelDrainService from '../lib/services/PixelDrain';
import GofileService from '../lib/services/Gofile';

describe('FichierService', () => {
  it('can scrape download links from 1fichier', async () => {
    const service = new FichierService();
    const links = await service.scrapeDownloadLinks(linksMap['1fichier']);

    expect(links).toBeDefined();
    expect(links.length).toBeGreaterThan(0);

    if (links.length > 0) {
      expect(links).toContainEqual({
        name: "1FICHIER",
        url: expect.any(String)
      });
    }
  }, Number.MAX_SAFE_INTEGER);
});

describe('PixelDrain', () => {
  it('can scrape download links from pixeldrain', async () => {
    const service = new PixelDrainService();
    const links = await service.scrapeDownloadLinks(linksMap.pixeldrain);
    expect(links).toBeDefined();
    expect(links.length).toBeGreaterThan(0);

    console.log(links);
    expect(links).toContainEqual({
      name: "PIXELDRAIN",
      url: expect.any(String)
    });
  }, Number.MAX_SAFE_INTEGER);
});

describe('Gofile', () => {
  it('can scrape download links from gofile', async () => {
    const service = new GofileService();
    const links = await service.scrapeDownloadLinks(linksMap.gofile);
    expect(links).toBeDefined();
    expect(links.length).toBeGreaterThan(0);
  }, Number.MAX_SAFE_INTEGER);
});