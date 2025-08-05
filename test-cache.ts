import Scraper from './lib/scraper';
import { Effect } from 'effect';

async function testCaching() {
  console.log('Testing scrape caching...');
  
  const scraper = new Scraper();
  
  // Test URL (this should trigger a real scrape)
  const testUrl = 'https://steamrip.com/game/cyberpunk-2077/';
  
  try {
    console.log('First call - should scrape and cache...');
    const result1 = await Effect.runPromise(scraper.scrapeGameDownloads(testUrl));
    console.log('First result:', result1.length, 'download links found');
    
    console.log('Second call - should load from cache...');
    const result2 = await Effect.runPromise(scraper.scrapeGameDownloads(testUrl));
    console.log('Second result:', result2.length, 'download links found');
    
    // Check if results are the same
    console.log('Results are identical:', JSON.stringify(result1) === JSON.stringify(result2));
    
    // Get cache stats
    const stats = await Effect.runPromise(scraper.getScrapeStats());
    console.log('Cache stats:', stats);
    
  } catch (error) {
    console.error('Error during test:', error);
  }
}

testCaching(); 