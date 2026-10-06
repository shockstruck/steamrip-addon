import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Effect } from 'effect';
import Scraper from '../lib/scraper';

describe('catalog file handling', () => {
  let dir: string;
  let scraper: Scraper;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'catalog-test-'));
    scraper = new Scraper({
      catalogPath: join(dir, 'catalog.json'),
      scrapesDir: join(dir, 'scrapes'),
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('treats a corrupt catalog.json as a typed failure, not a defect', async () => {
    await fs.writeFile(join(dir, 'catalog.json'), '{"games": [');
    const exit = await Effect.runPromiseExit(scraper.processLocals());
    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      expect(exit.cause._tag).toBe('Fail');
    }
    expect(await Effect.runPromise(scraper.processLocalsIfPresent())).toBe(false);
    expect(scraper.catalog.games).toEqual([]);
  });

  it('rejects valid JSON with the wrong shape', async () => {
    await fs.writeFile(join(dir, 'catalog.json'), '{}');
    const exit = await Effect.runPromiseExit(scraper.processLocals());
    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      expect(exit.cause._tag).toBe('Fail');
    }
  });

  it('writes the catalog atomically and leaves no temp file behind', async () => {
    const catalog = {
      games: [{ name: 'Example Game', url: 'https://example.invalid/game' }],
      lastUpdated: 1,
    };
    await Effect.runPromise(scraper.writeCatalog(catalog));
    expect((await fs.readdir(dir)).filter(f => f.startsWith('catalog.json'))).toEqual(['catalog.json']);
    expect(await Effect.runPromise(scraper.processLocalsIfPresent())).toBe(true);
    expect(scraper.catalog).toEqual(catalog);
  });
});
