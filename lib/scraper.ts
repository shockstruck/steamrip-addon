import { JSDOM } from 'jsdom';
import axios from 'axios';
import * as fs from 'fs/promises';
import { Effect } from 'effect';
import { FileSystemError, NetworkError, ScraperError } from './errors';
import { headerManager } from './header-manager';
import { join } from 'path';

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

// 24 hours in milliseconds
const SCRAPE_EXPIRY_MS = 24 * 60 * 60 * 1000;

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

  getHeaderObject(): Record<string, string> {
    return headerManager.getHeaderObject();
  }

  scrapeAllLinks(): Effect.Effect<{ name: string | undefined; url: string; }[], NetworkError | FileSystemError> {
    return Effect.gen(function*() {
      // Load headers if available
      yield* headerManager.loadHeaders();
      
      // Check if we have valid Cloudflare headers
      if (headerManager.requiresCloudflare && !headerManager.hasValidCloudflareHeaders()) {
        throw new Error('No valid Cloudflare headers found. Please solve Cloudflare protection first.');
      }
      
      const headers = headerManager.getHeaderObject();
      
      // Add some additional headers that might help with Cloudflare
      headers['DNT'] = '1';
      headers['Connection'] = 'keep-alive';
      
      const response = yield* Effect.tryPromise({
        try: () => axios.get('https://steamrip.com/games-list-page/', { 
          headers,
          timeout: 30000,
          maxRedirects: 5
        }),
        catch: (error) => {
          console.error('Request failed:', error);
          return new NetworkError({ url: 'https://steamrip.com/games-list-page/', error })
        }
      });
      
      console.log('Response status:', response.status);
      
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

  scrapeGameDownloads(url: string): Effect.Effect<{ service: string; url: string; }[], NetworkError | FileSystemError> {
    return Effect.gen(function*(this: Scraper) {
      // Ensure scrapes directory exists
      yield* this.ensureScrapesDirectory();
      
      // Try to load cached result first
      const cachedResult = yield* this.loadScrapeResult(url);
      if (cachedResult) {
        return cachedResult;
      }
      
      // Load headers if available
      yield* headerManager.loadHeaders();
      
      // Check if we have valid Cloudflare headers
      if (headerManager.requiresCloudflare && !headerManager.hasValidCloudflareHeaders()) {
        throw new Error('No valid Cloudflare headers found. Please solve Cloudflare protection first.');
      }
      
      const headers = headerManager.getHeaderObject();
      
      // Add some additional headers that might help with Cloudflare
      headers['DNT'] = '1';
      headers['Connection'] = 'keep-alive';
      
      const response = yield* Effect.tryPromise({
        try: () => axios.get(url, { 
          headers,
          timeout: 30000,
          maxRedirects: 5
        }),
        catch: (error) => {
          console.error('Game download request failed:', error);
          return new NetworkError({ url, error })
        }
      });
      
      console.log('Game download response status:', response.status);
      
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
      
      // Save the result to cache
      yield* this.saveScrapeResult(url, result);
      
      return result;
    }.bind(this));
  }
}