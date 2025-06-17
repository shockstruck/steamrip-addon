import type { Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import adblock from "puppeteer-extra-plugin-adblocker";
import { PUPPETEER_OPTIONS } from "./services/BaseService";
import { showInfoPopup } from "./popup-utils";

/**
 * Detects if a URL is from filecrypt domain (any TLD)
 */
export function isFilecryptUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return /filecrypt\./i.test(urlObj.hostname);
  } catch {
    return false;
  }
}

/**
 * Interface for filecrypt processing options
 */
export interface FilecryptOptions {
  /** Timeout in milliseconds for waiting for redirects (default: 60000) */
  redirectTimeout?: number;
  /** Whether to run in headless mode (default: true) */
  headless?: boolean;
}

/**
 * Shows an informational popup explaining what will happen when processing a filecrypt URL
 */
async function showFilecryptInfoPopup(url: string): Promise<void> {
  await showInfoPopup({
    title: "FileCrypt URL Detected",
    icon: "🔗",
    message: "We've detected a FileCrypt URL that needs processing:",
    infoBox: [
      { label: "URL", value: url }
    ],
    steps: [
      "A browser window will open to the FileCrypt page",
      "We'll wait for you to click 'Download' and get redirected to the download link", 
      "The final download URL will be used for OpenGameInstaller to process.",
    ],
    footerNote: "⏱️ This process typically takes 30-60 seconds",
    buttonText: "Continue with Processing",
    windowSize: { width: 650, height: 700 },
    testModeMessage: "Test Mode: This popup will close automatically"
  });
}

/**
 * Processes a filecrypt URL and returns the final download URL after redirect
 */
export async function processFilecryptUrl(
  url: string, 
  options: FilecryptOptions = {}
): Promise<string> {
  if (!isFilecryptUrl(url)) {
    throw new Error(`URL is not a filecrypt URL: ${url}`);
  }

  // Show informational popup first
  await showFilecryptInfoPopup(url);

  const {
    redirectTimeout = 20 * 60 * 1000,
    headless = false
  } = options;

  console.log(`[filecrypt] Processing filecrypt URL: ${url}`);

  // Setup puppeteer with plugins
  puppeteer.use(stealth());
  puppeteer.use(adblock({ blockTrackers: true }));

  const browser = await puppeteer.launch({
    ...PUPPETEER_OPTIONS,
    headless
  });

  try {
    const page = await browser.newPage();
    
    // Wait for the redirect to happen automatically
    const finalUrl = await waitForFilecryptRedirect(page, url, redirectTimeout);
    
    if (!finalUrl || isFilecryptUrl(finalUrl)) {
      throw new Error("Failed to get redirected to actual download link");
    }

    console.log(`[filecrypt] Final download URL: ${finalUrl}`);
    return finalUrl;

  } finally {
    await browser.close();
  }
}

/**
 * Waits for filecrypt to automatically redirect to the final download URL
 */
async function waitForFilecryptRedirect(
  page: Page, 
  initialUrl: string, 
  timeout: number
): Promise<string | null> {
  console.log(`[filecrypt] Loading page and waiting for redirect...`);
  
  const startTime = Date.now();
  let currentUrl = initialUrl;

  // Set up browser closure detection
  let browserClosed = false;
  const browser = page.browser();
  
  browser.on('disconnected', () => {
    browserClosed = true;
  });

  page.on('close', () => {
    browserClosed = true;
  });

  try {
    // Navigate to the initial URL
    await page.goto(initialUrl, { 
      waitUntil: "networkidle2",
      timeout: Math.min(timeout, 30000) // Cap initial navigation timeout at 30s
    });

    currentUrl = page.url();
    console.log(`[filecrypt] Initial page loaded: ${currentUrl}`);

    // If we were immediately redirected away from filecrypt, return the URL
    if (!isFilecryptUrl(currentUrl)) {
      console.log(`[filecrypt] Immediately redirected to: ${currentUrl}`);
      return currentUrl;
    }

    // Wait for automatic redirect by polling the current URL
    while (Date.now() - startTime < timeout) {
      // Check if browser was closed
      if (browserClosed || page.isClosed()) {
        throw new Error("Browser window was closed by user during FileCrypt processing");
      }

      await new Promise(resolve => setTimeout(resolve, 1000)); // Check every 1 second
      
      try {
        currentUrl = page.url();
      } catch (error) {
        if (browserClosed || page.isClosed()) {
          throw new Error("Browser window was closed by user during FileCrypt processing");
        }
        throw error;
      }
      
      if (!isFilecryptUrl(currentUrl)) {
        console.log(`[filecrypt] Redirected to: ${currentUrl}`);
        return currentUrl;
      }

      // Also wait for any navigation that might occur
      try {
        await page.waitForNavigation({ 
          waitUntil: "networkidle2", 
          timeout: 3000 
        });
        currentUrl = page.url();
        if (!isFilecryptUrl(currentUrl)) {
          console.log(`[filecrypt] Navigation detected, redirected to: ${currentUrl}`);
          return currentUrl;
        }
      } catch {
        // Navigation timeout is expected, continue polling
        // But check if browser was closed during navigation wait
        if (browserClosed || page.isClosed()) {
          throw new Error("Browser window was closed by user during FileCrypt processing");
        }
      }
    }

    console.log(`[filecrypt] Timeout waiting for redirect after ${timeout}ms`);
    return null;

  } catch (error) {
    if (browserClosed || page.isClosed()) {
      throw new Error("Browser window was closed by user during FileCrypt processing");
    }
    console.log(`[filecrypt] Error during redirect wait: ${error}`);
    return null;
  }
}

/**
 * Utility function for processing filecrypt URL with default options
 */
export async function processFilecryptWithPrompt(url: string): Promise<string> {
  if (!isFilecryptUrl(url)) {
    throw new Error(`URL is not a filecrypt URL: ${url}`);
  }

  console.log(`\n[filecrypt] Detected filecrypt URL: ${url}`);
  console.log(`[filecrypt] Waiting for automatic redirect to download link...`);

  return processFilecryptUrl(url, { 
    headless: true,
    redirectTimeout: 60000 // 60 second timeout
  });
}
