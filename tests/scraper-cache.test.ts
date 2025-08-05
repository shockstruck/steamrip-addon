import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import Scraper from '../lib/scraper';
import * as fs from 'fs/promises';
import { join } from 'path';
import { Effect } from 'effect';

describe('Scraper Cache', () => {
  let scraper: Scraper;
  const testUrl = 'https://steamrip.com/test-game';
  const testData = [{ service: 'TEST', url: 'https://example.com/test' }];

  beforeEach(async () => {
    scraper = new Scraper();
    // Clean up any existing test files
    try {
      await fs.rm('steamrip-scrapes', { recursive: true, force: true });
    } catch {}
  });

  afterEach(async () => {
    // Clean up after tests
    try {
      await fs.rm('steamrip-scrapes', { recursive: true, force: true });
    } catch {}
  });

  it('should create scrapes directory', async () => {
    const result = await Effect.runPromise(scraper.getScrapeStats());
    expect(result.total).toBe(0);
  });

  it('should save and load scrape results', async () => {
    // Save a test result
    await Effect.runPromise(scraper['saveScrapeResult'](testUrl, testData));
    
    // Load the result
    const loaded = await Effect.runPromise(scraper['loadScrapeResult'](testUrl));
    expect(loaded).toEqual(testData);
  });

  it('should handle non-existent scrape results', async () => {
    const loaded = await Effect.runPromise(scraper['loadScrapeResult']('https://steamrip.com/non-existent'));
    expect(loaded).toBeNull();
  });

  it('should generate consistent filenames', () => {
    const filename1 = scraper['getScrapeFileName'](testUrl);
    const filename2 = scraper['getScrapeFileName'](testUrl);
    expect(filename1).toBe(filename2);
    expect(filename1).toMatch(/^[a-zA-Z0-9]+\.json$/);
  });

  it('should provide scrape statistics', async () => {
    // Save a test result
    await Effect.runPromise(scraper['saveScrapeResult'](testUrl, testData));
    
    const stats = await Effect.runPromise(scraper.getScrapeStats());
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.valid).toBeGreaterThan(0);
    expect(stats.expired).toBe(0);
  });
}); 