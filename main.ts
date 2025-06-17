import OGIAddon, { SearchTool } from "ogi-addon";
import Scraper, { SCRAPE_PRIORITY } from "./lib/scraper";
import puppeteer from "puppeteer-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import adblock from "puppeteer-extra-plugin-adblocker";
import { getService } from "./lib/services/matcher";

puppeteer.use(stealth());
puppeteer.use(adblock());

const scraper = new Scraper();
const search = new SearchTool<{ name: string, url: string }>([], ['name']);

const addon = new OGIAddon({
  name: 'steamrip-addon',
  version: '1.0.0',
  id: 'steamrip-addon',

  author: 'fat-addons',
  description: 'an addon to scrape steamrip and give you links.',
  repository: 'https://github.com/fat-addons/steamrip-addon'
});

addon.on('configure', (config) => config)

addon.on('connect', () => {
  console.log('connected to ogi');
  new Promise(async (resolve, reject) => {
    const task = await addon.task();
    task.log('Implementing local catalog...');
    await scraper.upgradeLocals();
    task.log('Processing local catalog...');
    await scraper.processLocals();
    search.addItems(scraper.catalog.games);
  });
});

addon.on('search', (query, event) => {
  if (query.type !== 'steamapp') {
    event.resolve([]);
    return;
  }
  event.defer();
  new Promise(async (resolve, reject) => {
    const steamResults = await addon.steamSearch(query.text, true)
    if (steamResults.length === 0) {
      event.resolve([]);
      return;
    }
    const steamResult = steamResults[0];
    // Find the game with the highest name similarity to the Steam result
    let bestMatch: { name: string; url: string } | undefined;
    let bestScore = 0;
    for (const candidate of scraper.catalog.games) {
      const score = stringSimilarity(candidate.name, steamResult.name);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    // Require a minimum similarity to consider it a valid match
    const SIMILARITY_THRESHOLD = 0.5;
    const game = bestScore >= SIMILARITY_THRESHOLD ? bestMatch : undefined;

    if (!game) {
      event.resolve([]);
      return;
    }

    event.resolve([{
      name: game.name,
      downloadType: 'request',
      storefront: 'steam'
    }]);

  });
});

addon.on('request-dl', (appid, info, event) => {
  // alright, now its time to download the game. we first gotta get the available dl links
  const game = scraper.catalog.games.find(game => game.name === info.name);
  if (!game) {
    event.complete();
    return;
  }
  event.defer();

  new Promise(async (resolve, reject) => {
    const dlLinks = await scraper.scrapeGameDownloads(game.url);
    const priorities = dlLinks.map(link => SCRAPE_PRIORITY[link.service as keyof typeof SCRAPE_PRIORITY]);
    const bestService = dlLinks[priorities.indexOf(Math.max(...priorities))];
    const downloadLinks = await getService(bestService.service).scrapeDownloadLinks(bestService.url);
  });
})

addon.on('disconnect', () => {
  process.exit(0);
});

// Dice coefficient based similarity between two strings (case-insensitive)
function stringSimilarity(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();

  // Return early for trivial equality
  if (a === b) return 1;

  // Create bigrams for each string
  const bigrams = (str: string): string[] => {
    const s = str.replace(/[^a-z0-9]+/g, ' '); // keep alphanumerics, replace others with space
    const pairs: string[] = [];
    for (let i = 0; i < s.length - 1; i++) {
      pairs.push(s.substring(i, i + 2));
    }
    return pairs;
  };

  const pairsA = bigrams(a);
  const pairsB = bigrams(b);

  if (pairsA.length === 0 || pairsB.length === 0) return 0;

  let intersection = 0;
  const pairsBMutable = [...pairsB];
  for (const pair of pairsA) {
    const idx = pairsBMutable.indexOf(pair);
    if (idx !== -1) {
      intersection++;
      pairsBMutable.splice(idx, 1); // remove to prevent double counting
    }
  }

  return (2 * intersection) / (pairsA.length + pairsB.length);
}

