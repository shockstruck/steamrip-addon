import { JSDOM } from 'jsdom';
import * as fs from 'fs/promises';
import { Effect } from 'effect';
import { FileSystemError, NetworkError, ScraperError } from './errors';
import { headerManager } from './header-manager';
import { fetchSteamripHtml } from './steamrip-fetch';
import { join } from 'path';
import type { DownloadLink } from './services/matcher';

// 8 hours in milliseconds
const SCRAPE_EXPIRY_MS = 8 * 60 * 60 * 1000;

export default class Scraper {
  public catalog: { games: { name: string, url: string }[], lastUpdated: number } = { games: [], lastUpdated: 0 };
  private scrapesDir = 'steamrip-scrapes';
  
  constructor() {
    // Initialize directory creation
    Effect.runPromise(this.ensureScrapesDirectory()).catch(error => {
      console.error('Failed to create scrapes directory:', error);
    });
  }

  private ensureScrapesDirectory(): Effect.Effect<void, FileSystemError> {
    return Effect.tryPromise({
      try: async () => {
        try {
          await fs.access(this.scrapesDir);
        } catch {
          await fs.mkdir(this.scrapesDir, { recursive: true });
        }
      },
      catch: (error) => new FileSystemError({ path: this.scrapesDir, error })
    });
  }

  public cleanupExpiredScrapes(): Effect.Effect<void, FileSystemError> {
    return Effect.gen(function*(this: Scraper) {
      yield* this.ensureScrapesDirectory();
      yield* this.cleanupExpiredScrapesInternal();
    }.bind(this));
  }

  public cleanupAllScrapes(): Effect.Effect<void, FileSystemError> {
    return Effect.tryPromise({
      try: async () => {
        if (!await fs.access(this.scrapesDir).then(() => true).catch(() => false)) {
          return;
        }
        const files = await fs.readdir(this.scrapesDir);
        for (const file of files) {
          if (file.endsWith('.json')) {
            await fs.unlink(join(this.scrapesDir, file));
            console.log(`Cleaned up scrape: ${file}`);
          }
        }
      },
      catch: (error) => new FileSystemError({ path: this.scrapesDir, error })
    });
  }

  public getScrapeStats(): Effect.Effect<{ total: number; expired: number; valid: number }, FileSystemError> {
    return Effect.tryPromise({
      try: async () => {
        try {
          await fs.access(this.scrapesDir);
        } catch {
          return { total: 0, expired: 0, valid: 0 };
        }
        
        const files = await fs.readdir(this.scrapesDir);
        const now = Date.now();
        let expired = 0;
        let valid = 0;
        
        for (const file of files) {
          if (file.endsWith('.json')) {
            const filePath = join(this.scrapesDir, file);
            const stats = await fs.stat(filePath);
            
            if (now - stats.mtime.getTime() > SCRAPE_EXPIRY_MS) {
              expired++;
            } else {
              valid++;
            }
          }
        }
        
        return { total: files.length, expired, valid };
      },
      catch: (error) => new FileSystemError({ path: this.scrapesDir, error })
    });
  }

  private cleanupExpiredScrapesInternal(): Effect.Effect<void, FileSystemError> {
    return Effect.tryPromise({
      try: async () => {
        const files = await fs.readdir(this.scrapesDir);
        const now = Date.now();
        
        for (const file of files) {
          if (file.endsWith('.json')) {
            const filePath = join(this.scrapesDir, file);
            const stats = await fs.stat(filePath);
            
            if (now - stats.mtime.getTime() > SCRAPE_EXPIRY_MS) {
              await fs.unlink(filePath);
              console.log(`Cleaned up expired scrape: ${file}`);
            }
          }
        }
      },
      catch: (error) => new FileSystemError({ path: this.scrapesDir, error })
    });
  }

  private getScrapeFileName(url: string): string {
    // Create a safe filename from the URL
    const urlHash = Buffer.from(url).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
    return `${urlHash}.json`;
  }

  private saveScrapeResult(url: string, data: any): Effect.Effect<void, FileSystemError> {
    return Effect.tryPromise({
      try: async () => {
        console.log('Saving scrape result:', url);
        const fileName = this.getScrapeFileName(url);
        const filePath = join(this.scrapesDir, fileName);
        
        const scrapeData = {
          url,
          data,
          timestamp: Date.now(),
          expiresAt: Date.now() + SCRAPE_EXPIRY_MS
        };
        
        await fs.writeFile(filePath, JSON.stringify(scrapeData, null, 2));
        console.log(`Saved scrape result: ${fileName}`);
      },
      catch: (error) => new FileSystemError({ path: join(this.scrapesDir, this.getScrapeFileName(url)), error })
    });
  }

  private loadScrapeResult(url: string): Effect.Effect<any | null, FileSystemError> {
    return Effect.tryPromise({
      try: async () => {
        const fileName = this.getScrapeFileName(url);
        const filePath = join(this.scrapesDir, fileName);
        
        try {
          const content = await fs.readFile(filePath, 'utf8');
          const scrapeData = JSON.parse(content);
          
          // Check if expired
          if (Date.now() > scrapeData.expiresAt) {
            await fs.unlink(filePath);
            console.log(`Removed expired scrape: ${fileName}`);
            return null;
          }
          
          console.log(`Loaded cached scrape result: ${fileName}`);
          return scrapeData.data;
        } catch {
          return null; // File doesn't exist or can't be read
        }
      },
      catch: (error) => new FileSystemError({ path: join(this.scrapesDir, this.getScrapeFileName(url)), error })
    });
  }
  
  upgradeLocals(force: boolean = false): Effect.Effect<void, FileSystemError | NetworkError | ScraperError> {
    return Effect.gen(function*(this: Scraper) {
      // Ensure scrapes directory exists
      yield* this.ensureScrapesDirectory();
      
      // Clean up expired scrapes
      yield* this.cleanupExpiredScrapesInternal();
      
      if (
        !force &&
        this.catalog.games.length > 0 &&
        this.catalog.lastUpdated > Date.now() - 1000 * 60 * 60 * 24
      ) {
        return;
      }
      const games = yield* this.scrapeAllLinks();
      if (games.length === 0) {
        return yield* Effect.fail(
          new ScraperError({ error: new Error("Steamrip catalog scrape returned no games") }),
        );
      }
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

  getHeaderObject(): Record<string, string> {
    return headerManager.getHeaderObject();
  }

  scrapeAllLinks(): Effect.Effect<{ name: string | undefined; url: string; }[], NetworkError | FileSystemError> {
    return Effect.gen(function*() {
      const html = yield* fetchSteamripHtml('https://steamrip.com/games-list-page/');
      const dom = new JSDOM(html);
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

  processLocalsIfPresent(): Effect.Effect<boolean, never> {
    return this.processLocals().pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false))
    );
  }

  scrapeGameDownloads(url: string): Effect.Effect<DownloadLink[], NetworkError | FileSystemError> {
    return Effect.gen(function*(this: Scraper) {
      yield* this.ensureScrapesDirectory();

      const cachedResult = yield* this.loadScrapeResult(url);
      if (cachedResult) {
        return cachedResult;
      }

      const html = yield* fetchSteamripHtml(url);
      const dom = new JSDOM(html);
      const document = dom.window.document;
      const result: DownloadLink[] = [];
      document.querySelectorAll('p[style*="text-align: center"]').forEach(p => {
        const link = p.querySelector('a.shortc-button') as HTMLAnchorElement | null;
        const label = (p.querySelector('strong') || p.querySelector('span')) as HTMLElement | null;

        if (link && label?.textContent) {
          const href = link.getAttribute('href');
          if (!href) return;
          const finalUrl = href.startsWith('//') ? 'https:' + href : href;
          if (finalUrl) result.push({ url: finalUrl });
        }
      });

      yield* this.saveScrapeResult(url, result);
      return result;
    }.bind(this));
  }
}