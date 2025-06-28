import { JSDOM } from 'jsdom';
import axios from 'axios';
import * as fs from 'fs/promises';
import { Effect } from 'effect';
import { FileSystemError, NetworkError, ScraperError } from './errors';

// Priority scraper ranking:
// 0 - impossible to get it effectively
// 10 - best chance to get it effectively

export const SCRAPE_PRIORITY = {
  // if scrape priority is 0, we will not choose it, as its quite literally impossible to get it effectively
  'GOFILE': 0,
  'Buzzheavier': 10,
  'DataNodes': 0,
  'MegaDB': 0,
  '1FICHIER': 9,
  'PixelDrain': 10,
  'FILECRYPT': 8 // High priority since it's a link redirector that leads to actual download links
}
export default class Scraper {
  public catalog: { games: { name: string, url: string }[], lastUpdated: number } = { games: [], lastUpdated: 0 };
  
  upgradeLocals(force: boolean = false): Effect.Effect<void, FileSystemError | NetworkError | ScraperError> {
    return Effect.gen(function*(this: Scraper) {
      if (!force && this.catalog.lastUpdated > Date.now() - 1000 * 60 * 60 * 24) {
        return;
      }
      const games = yield* this.scrapeAllLinks();
      const catalogObject = {
        games: games,
        lastUpdated: Date.now()
      };
      yield* Effect.tryPromise({
        try: () => fs.writeFile('catalog.json', JSON.stringify(catalogObject, null, 2)),
        catch: (error) => new FileSystemError({ path: 'catalog.json', error })
      });
      console.log('catalog.json updated');
    }.bind(this));
  }

  scrapeAllLinks(): Effect.Effect<{ name: string | undefined; url: string; }[], NetworkError> {
    return Effect.gen(function*() {
      const response = yield* Effect.tryPromise({
        try: () => axios.get('https://steamrip.com/games-list-page/'),
        catch: (error) => new NetworkError({ url: 'https://steamrip.com/games-list-page/', error })
      });
      const dom = new JSDOM(response.data);
      const document = dom.window.document;

      const gameLinks = Array.from(document.querySelectorAll('.az-list-item a'));
      return gameLinks.map((link: Element) => {
        const name = link.textContent?.trim();
        const href = link.getAttribute('href')?.trim();
        const url = href ? 'https://steamrip.com' + href : '';
        return { name, url };
      });
    });
  }

  processLocals(): Effect.Effect<void, FileSystemError> {
    return Effect.gen(function*(this: Scraper) {
      const catalogContent = yield* Effect.tryPromise({
        try: () => fs.readFile('catalog.json', 'utf8'),
        catch: (error) => new FileSystemError({ path: 'catalog.json', error })
      });
      this.catalog = JSON.parse(catalogContent);
    }.bind(this));
  }

  scrapeGameDownloads(url: string): Effect.Effect<{ service: string; url: string; }[], NetworkError> {
    return Effect.gen(function*() {
      const response = yield* Effect.tryPromise({
        try: () => axios.get(url),
        catch: (error) => new NetworkError({ url, error })
      });
      const dom = new JSDOM(response.data);
      const document = dom.window.document;
      const result: { service: string, url: string }[] = [];
      document.querySelectorAll('p[style*="text-align: center"]').forEach(p => {
        const link = p.querySelector('a.shortc-button') as HTMLAnchorElement | null;
        const label = (p.querySelector('strong') || p.querySelector('span')) as HTMLElement | null;

        if (link && label && label.textContent) {
          const href = link.getAttribute('href');
          let finalUrl = '';
          if (href) {
            finalUrl = href.startsWith('//') ? 'https:' + href : href;
          }
          result.push({
            service: label.textContent.trim().toUpperCase(),
            url: finalUrl
          });
        }
      });
      return result;
    });
  }
}