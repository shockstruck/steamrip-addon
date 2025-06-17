import { JSDOM } from 'jsdom';
import axios from 'axios';
import * as fs from 'fs/promises';

// Priority scraper ranking:
// 0 - impossible to get it effectively
// 10 - best chance to get it effectively

export const SCRAPE_PRIORITY = {
  // if scrape priority is 0, we will not choose it, as its quite literally impossible to get it effectively
  'GOFILE': 0,
  'Buzzheavier': 10,
  'DataNodes': 0,
  'MegaDB': 0,
  '1FICHIER': 9
}
export default class Scraper {
  public catalog: { games: { name: string, url: string }[], lastUpdated: number } = { games: [], lastUpdated: 0 };
  async upgradeLocals(force: boolean = false) {
    if (!force) {
      if (this.catalog.lastUpdated > new Date().getTime() - 1000 * 60 * 60 * 24) {
        return;
      }
    }
    const games = await this.scrapeAllLinks();
    const object = {
      games: games,
      lastUpdated: new Date().getTime()
    }
    await fs.writeFile('catalog.json', JSON.stringify(object, null, 2));
    console.log('catalog.json updated');
  }
  async scrapeAllLinks() {
    const response = await axios.get('https://steamrip.com/games-list-page/');
    const dom = new JSDOM(response.data);
    const document = dom.window.document;

    // Extract all game links
    const gameLinks = Array.from(document.querySelectorAll('.az-list-item a'));
    const games = gameLinks.map((link: Element) => {
      const name = link.textContent?.trim();
      const url = 'https://steamrip.com' + link.getAttribute('href')?.trim();
      return { name, url };
    });

    return games;
  }
  async processLocals() {
    const catalog = await fs.readFile('catalog.json', 'utf8');
    this.catalog = JSON.parse(catalog);
  }

  async scrapeGameDownloads(url: string) {
    const response = await axios.get(url);
    const dom = new JSDOM(response.data);
    const document = dom.window.document;
    const result: { service: string, url: string }[] = [];
    document.querySelectorAll('p[style*="text-align: center"]').forEach(p => {
      const link = p.querySelector('a.shortc-button') as HTMLAnchorElement | null;
      const label = (p.querySelector('strong') || p.querySelector('span')) as HTMLElement | null;

      if (link && label && label.textContent) {
        const href = link.getAttribute('href');
        let url = '';
        if (href) {
          url = href.startsWith('//') ? 'https:' + href : href;
        }
        result.push({
          service: label.textContent.trim().toUpperCase(),
          url: url
        });
      }
    });


    return result;
  }
}