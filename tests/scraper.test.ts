/*
* This file is used to test the scraper and services.
* All links must be provided in the LINKS.txt file.
* We do not provide any links, you must find them yourself to test the scraper.
*/

import Scraper from '../lib/scraper';
import { describe, it, expect } from 'bun:test';
import BuzzHeavierService from '../lib/services/BuzzHeavier';


type ValidLink = 'steamrip' | 'buzzheavier' | '1fichier' | 'pixeldrain' | 'gofile' | 'filecrypt-test';
const emptyEvent = new EventResponse<SearchResult>((_, _1, _2) => Promise.resolve({}));
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
    const links = await Effect.runPromise(scraper.scrapeAllLinks());
    expect(links).toBeDefined();
    expect(links.length).toBeGreaterThan(0);

    expect(links).toContainValue({
      name: "Half-Life Free Download",
      url: "https://steamrip.com/half-life-free-download-m1/"
    });
  });

  it('can scrape game downloads and provide the correct values', async () => {
    const scraper = new Scraper();
    const links = await Effect.runPromise(scraper.scrapeGameDownloads(linksMap.steamrip));
    expect(links).toBeDefined();
    expect(links.length).toBeGreaterThan(0);
  });
});

describe('Buzzheavier', () => {
  it('can scrape download links', async () => {
    const service = new BuzzHeavierService();
    const links = await Effect.runPromise(service.scrapeDownloadLinks(linksMap.buzzheavier, emptyEvent));
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
import { EventResponse } from 'ogi-addon';
import type { SearchResult } from 'ogi-addon';
import { Effect } from 'effect';
import axios from 'axios';
import { createWriteStream } from 'fs';

describe('FichierService', () => {
  it('can scrape download links from 1fichier', async () => {
    const service = new FichierService();
    const links = await Effect.runPromise(service.scrapeDownloadLinks(linksMap['1fichier'], emptyEvent));

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
    const links = await Effect.runPromise(service.scrapeDownloadLinks(linksMap.pixeldrain, emptyEvent));
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
    const links = await Effect.runPromise(service.scrapeDownloadLinks(linksMap.gofile, emptyEvent));
    expect(links).toBeDefined();
    expect(links.length).toBeGreaterThan(0);

    // try and start a download with the headers provided adn the url
    const download = await axios.get(links[0].url, {
      headers: links[0].headers,
      responseType: 'stream'
    });
    console.log('Download', download.status);
    expect(download.status).toBe(200);
    // download to ./test-file.rar
    const stream = createWriteStream('./test-file.rar');
    download.data.pipe(stream);
    await new Promise<void>((resolve, reject) => {
      const contentLength = download.headers['content-length'];
      const contentLengthMB = contentLength ? (Number(contentLength) / (1024 * 1024)).toFixed(2) : 'unknown';
      console.log(`Downloading... Content-Length: ${contentLength} bytes (${contentLengthMB} MB)`);
      // get the expected file size, and if it's already greater than that, then we can just resolve
      const expectedFileSize = contentLength;
      if (expectedFileSize && stream.bytesWritten >= expectedFileSize) {
        console.log('File verified as good, skipping download', expectedFileSize, stream.bytesWritten);
        download.data.destroy();
        resolve();
        return;
      }
      stream.on('finish', () => {
        console.log('Download finished');
        // read the file size and expect it to be greater than 6 mb
        const fileSize = Bun.file('./test-file.rar').size;
        expect(fileSize).toBeGreaterThan(6 * 1024 * 1024);
        resolve();
      });
      stream.on('data', () => {
        console.log('Progressing through download...')
      });
      stream.on('error', (error) => {
        console.error('Download error', error);
        reject(error);
      });
    });

    console.log('Download finished');
  }, Number.MAX_SAFE_INTEGER);
});