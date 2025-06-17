import puppeteer, { type VanillaPuppeteer } from "puppeteer-extra";
export const PUPPETEER_OPTIONS: Parameters<VanillaPuppeteer["launch"]>[0] = {
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-sync",
    "--ignore-certificate-errors",
    "--lang=en-US,en;q=0.9",
  ],
  defaultViewport: { width: 1366, height: 768 }
}

export class DLService {
  public name: string;
  public priority: number;
  public constructor(name: string, priority: number) {
    this.name = name;
    this.priority = priority;
  }
  async scrapeDownloadLinks(url: string): Promise<{ name: string, url: string }[]> {
    throw new Error('Not implemented');
  }
}
