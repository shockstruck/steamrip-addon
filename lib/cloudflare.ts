import { Data, Effect } from "effect";
import type OGIAddon from "ogi-addon";
import { headerManager, convertPuppeteerCookies } from "./header-manager";
import axios, { type AxiosResponse } from "axios";
import type { Page } from "puppeteer";
import { connect, type PageWithCursor } from "puppeteer-real-browser";
import { PUPPETEER_OPTIONS } from "./services/BaseService";

export class CloudflareTestError extends Data.TaggedError('CloudflareTestError')<{
  url: string;
  error: unknown;
}> {}

export const cloudflareSolve = (url: string, addon: OGIAddon) => Effect.gen(function* () {
  // Load existing headers first
  yield* headerManager.loadHeaders();
  
  // Check if we have valid Cloudflare headers
  const hasValidCloudflareHeaders = () => {
    const headers = headerManager.getHeaders();
    // Check for Cloudflare-specific cookies that indicate a successful solve
    const cloudflareCookies = headers.cookies.filter(cookie => 
      cookie.name.includes('cf_') || 
      cookie.name.includes('__cf') ||
      cookie.name.includes('cloudflare') ||
      cookie.name === 'cf_clearance'
    );
    return cloudflareCookies.length > 0;
  };
  
  // If we already have valid Cloudflare headers, test them first
  if (hasValidCloudflareHeaders()) {
    // Test if existing headers are still valid
    const testResponse = yield* Effect.tryPromise({
      try: () => axios.get(url, { 
        headers: headerManager.getHeaderObject(),
        timeout: 10000,
      }),
      catch: () => undefined
    }).pipe(Effect.catchAll((err) => {
      console.log('Error:', err);
      return Effect.succeed(undefined);
    }));

    if (!testResponse) {
      console.log('Test request failed');
    } else if (testResponse.status === 200 && !(testResponse.data as string).includes('Cloudflare')) {
      return headerManager.getHeaders(); // Return the valid headers instead of null
    }
  }

  // check using axios to see if we can just get the page
  console.log('Checking if we can just get the page');
  const testResponse = yield* Effect.tryPromise(async () => {
    const response = await axios.get(url, { 
      headers: headerManager.getHeaderObject(),
      timeout: 10000,
    });
    console.log('Response:', response);
    return response.status === 200 && !(response.data as string).includes('Cloudflare');
  }).pipe(Effect.catchAll((err) => {
    console.log('Error:', err);
    return Effect.succeed(false);
  }));
  console.log('testResponse:', testResponse);

  if (testResponse) {
    headerManager.requiresCloudflare = false;
    return headerManager.getHeaders();
  }

  const headlessConn = yield* Effect.tryPromise(() => connect({ headless: true, disableXvfb: true, args: PUPPETEER_OPTIONS.args })).pipe(Effect.catchAll((err) => {
    console.log('Failed to launch headless browser, will try visible browser:', err);
    return Effect.succeed(undefined);
  }));

  if (!headlessConn) {
    console.log('Headless browser failed to launch, attempting visible browser instead...');

    // Try with visible browser directly
    const visibleConn = yield* Effect.tryPromise({
      try: () => connect({ headless: false, turnstile: true, disableXvfb: true, args: [ ...(PUPPETEER_OPTIONS.args || [])] }),
      catch: (error) => new Error(`Failed to launch browser: ${error}`)
    });

    const { browser, page: visiblePage } = visibleConn;

    // Set up request interception for visible page
    const visibleCapturedHeaders: Record<string, string> = {};
    yield* Effect.tryPromise({
      try: () => visiblePage.setRequestInterception(true),
      catch: () => new Error('Failed to set request interception')
    });

    visiblePage.on('request', (request) => {
      // Capture headers from the first request to the target domain
      if (request.url().includes('steamrip.com') && Object.keys(visibleCapturedHeaders).length === 0) {
        Object.entries(request.headers()).forEach(([key, value]) => {
          if (value) {
            visibleCapturedHeaders[key] = value;
          }
        });
      }
      request.continue();
    });

    yield* Effect.tryPromise({
      try: () => visiblePage.goto(url),
      catch: () => new Error('Failed to navigate to URL')
    });

    yield* Effect.sync(() => addon.notify({
      message: 'Headless browser failed. Please solve the Cloudflare challenge in the opened browser window.',
      id: 'cloudflare-captcha',
      type: 'warning',
    }));

    const visibleResult = yield* contentWaiter(60, visiblePage);

    if (!visibleResult) {
      // Immediately kill the browser window
      yield* Effect.tryPromise({
        try: async () => {
          // Force close all pages first
          const pages = await browser.pages();
          await Promise.all(pages.map(p => p.close().catch(() => {})));
          // Then close the browser
          await browser.close();
        },
        catch: () => new Error('Failed to close browser')
      });

      yield* Effect.sync(() => addon.notify({
        message: 'Failed to solve Cloudflare captcha.',
        id: 'cloudflare-captcha',
        type: 'error',
      }));

      throw new Error('Failed to solve Cloudflare captcha');
    } else {
      // Capture all headers from the visible page
      const headers = yield* captureBrowserHeaders(visiblePage, visibleCapturedHeaders);
      console.log('Headers:', headers);

      // Verify we have Cloudflare headers before storing
      const cloudflareCookies = headers.cookies.filter(cookie =>
        cookie.name.includes('cf_') ||
        cookie.name.includes('__cf') ||
        cookie.name.includes('cloudflare') ||
        cookie.name === 'cf_clearance'
      );

      if (cloudflareCookies.length === 0) {
        yield* Effect.sync(() => addon.notify({
          message: 'Cloudflare solve completed but no Cloudflare cookies found. Retrying...',
          id: 'cloudflare-captcha',
          type: 'warning',
        }));

        yield* Effect.tryPromise({
          try: () => browser.close(),
          catch: () => new Error('Failed to close browser')
        });

        throw new Error('No Cloudflare cookies found after solve');
      }

      // Store all headers
      yield* headerManager.setHeaders(headers);

      // Close browser after getting headers
      yield* Effect.tryPromise({
        try: () => browser.close(),
        catch: () => new Error('Failed to close browser')
      });

      return headers;
    }
  }

  const { browser: browserHeadless, page } = headlessConn;

  // Set up request interception to capture headers
  const capturedHeaders: Record<string, string> = {};
  yield* Effect.tryPromise({
    try: () => page.setRequestInterception(true),
    catch: () => new Error('Failed to set request interception')
  });

  page.on('request', (request) => {
    // Capture headers from the first request to the target domain
    if (request.url().includes('steamrip.com') && Object.keys(capturedHeaders).length === 0) {
      Object.entries(request.headers()).forEach(([key, value]) => {
        if (value) {
          capturedHeaders[key] = value;
        }
      });
    }
    request.continue();
  });
  
  yield* Effect.tryPromise({
    try: () => page.goto(url),
    catch: () => new Error('Failed to navigate to URL')
  });

  const contentWaiter = (timeoutSeconds: number, page: PageWithCursor | Page) => Effect.gen(function* () {
    const maxAttempts = timeoutSeconds * 10;
    let attempts = 0;
    let successfulChecks = 0;
    const requiredSuccessfulChecks = 30; // 3 seconds of stable state (30 * 100ms)

    while (attempts < maxAttempts) {
      // Check if page is closed
      const isClosed = yield* Effect.tryPromise({
        try: () => Promise.resolve(page.isClosed()),
        catch: () => new Error('Failed to check if page is closed')
      });

      if (isClosed) {
        return false;
      }

      // Get current URL to check if we're on steamrip.com
      const currentUrl = yield* Effect.try({
        try: () => page.url(),
        catch: () => new Error('Failed to get page URL')
      });

      // Get page content
      const content = yield* Effect.tryPromise({
        try: () => page.content(),
        catch: () => new Error('Failed to get page content')
      });

      // Check if we're on steamrip.com and not on a Cloudflare challenge page
      const onSteamrip = currentUrl.includes('steamrip.com');
      const hasCloudflareChallenge = content.includes('Cloudflare') || content.includes('Just a moment') || content.includes('Checking your browser');

      if (onSteamrip && !hasCloudflareChallenge) {
        successfulChecks++;
        if (successfulChecks >= requiredSuccessfulChecks) {
          console.log('Successfully reached steamrip.com, Cloudflare solved (stable for 3 seconds)');
          console.log('Current URL:', currentUrl);
          return true;
        }
        if (successfulChecks % 10 === 0) {
          console.log(`Cloudflare challenge passed, confirming stability... (${successfulChecks}/${requiredSuccessfulChecks})`);
        }
      } else {
        // Reset counter if we see Cloudflare again (handles page refreshes)
        if (successfulChecks > 0) {
          console.log('Cloudflare challenge detected again (page refresh), resetting stability counter');
        }
        successfulChecks = 0;
      }

      // Log redirect attempts for debugging
      if (!onSteamrip && attempts % 10 === 0) {
        console.log(`Waiting for redirect to steamrip.com... Current URL: ${currentUrl}`);
      }

      // Wait 100ms before next attempt
      yield* Effect.sleep(100);
      attempts++;
    }

    return false;
  });

  const headlessResult = yield* contentWaiter(7, page);
  
  if (!headlessResult) {
    yield* Effect.sync(() => addon.notify({
      message: 'Steamrip requires a Cloudflare captcha to be solved. Please solve it in the new window opened.',
      id: 'cloudflare-captcha',
      type: 'warning',
    }));
    
    yield* Effect.tryPromise({
      try: () => browserHeadless.close(),
      catch: () => new Error('Failed to close headless browser')
    });
    
    const visibleConn = yield* Effect.tryPromise({
      try: () => connect({ headless: false, turnstile: true, disableXvfb: true, args: [ ...(PUPPETEER_OPTIONS.args || [])] }),
      catch: () => new Error('Failed to launch browser')
    });

    const { browser, page: visiblePage } = visibleConn;

    // Set up request interception for visible page too
    const visibleCapturedHeaders: Record<string, string> = {};
    yield* Effect.tryPromise({
      try: () => visiblePage.setRequestInterception(true),
      catch: () => new Error('Failed to set request interception')
    });

    visiblePage.on('request', (request) => {
      // Capture headers from the first request to the target domain
      if (request.url().includes('steamrip.com') && Object.keys(visibleCapturedHeaders).length === 0) {
        Object.entries(request.headers()).forEach(([key, value]) => {
          if (value) {
            visibleCapturedHeaders[key] = value;
          }
        });
      }
      request.continue();
    });
    
    yield* Effect.tryPromise({
      try: () => visiblePage.goto(url),
      catch: () => new Error('Failed to navigate to URL')
    });
    
    const visibleResult = yield* contentWaiter(60, visiblePage);

    if (!visibleResult) {
      // Immediately kill the browser window
      yield* Effect.tryPromise({
        try: async () => {
          // Force close all pages first
          const pages = await browser.pages();
          await Promise.all(pages.map(p => p.close().catch(() => {})));
          // Then close the browser
          await browser.close();
        },
        catch: () => new Error('Failed to close browser')
      });

      yield* Effect.sync(() => addon.notify({
        message: 'Failed to solve Cloudflare captcha.',
        id: 'cloudflare-captcha',
        type: 'error',
      }));

      throw new Error('Failed to solve Cloudflare captcha');
    } else {
      // Capture all headers from the visible page
      const headers = yield* captureBrowserHeaders(visiblePage, visibleCapturedHeaders);
      console.log('Headers:', headers);

      // Verify we have Cloudflare headers before storing
      const cloudflareCookies = headers.cookies.filter(cookie =>
        cookie.name.includes('cf_') ||
        cookie.name.includes('__cf') ||
        cookie.name.includes('cloudflare') ||
        cookie.name === 'cf_clearance'
      );
      
      if (cloudflareCookies.length === 0) {
        yield* Effect.sync(() => addon.notify({
          message: 'Cloudflare solve completed but no Cloudflare cookies found. Retrying...',
          id: 'cloudflare-captcha',
          type: 'warning',
        }));
        
        yield* Effect.tryPromise({
          try: () => browser.close(),
          catch: () => new Error('Failed to close browser')
        });
        
        throw new Error('No Cloudflare cookies found after solve');
      }

      // Store all headers
      yield* headerManager.setHeaders(headers);

      // Close browser after getting headers
      yield* Effect.tryPromise({
        try: () => browser.close(),
        catch: () => new Error('Failed to close browser')
      });

      return headers;
    }
  }

  // Capture all headers from the headless browser
  const headers = yield* captureBrowserHeaders(page, capturedHeaders);
  
  // Verify we have Cloudflare headers before storing
  const cloudflareCookies = headers.cookies.filter(cookie => 
    cookie.name.includes('cf_') || 
    cookie.name.includes('__cf') ||
    cookie.name.includes('cloudflare') ||
    cookie.name === 'cf_clearance'
  );
  
  if (cloudflareCookies.length === 0) {
    yield* Effect.sync(() => addon.notify({
      message: 'Headless Cloudflare solve completed but no Cloudflare cookies found. Retrying with visible browser...',
      id: 'cloudflare-captcha',
      type: 'warning',
    }));
    
    yield* Effect.tryPromise({
      try: () => browserHeadless.close(),
      catch: () => new Error('Failed to close headless browser')
    });
    
    throw new Error('No Cloudflare cookies found after headless solve');
  }
  
  // Store all headers
  yield* headerManager.setHeaders(headers);

  // on success, close the headless browser after getting headers
  yield* Effect.tryPromise({
    try: () => browserHeadless.close(),
    catch: () => new Error('Failed to close headless browser')
  });
  
  return headers;
});

// Helper function to capture all headers from a browser page
const captureBrowserHeaders = (page: PageWithCursor, capturedHeaders: Record<string, string> = {}) => Effect.gen(function* () {
  // Get cookies
  const cookies = yield* Effect.tryPromise({
    try: () => page.cookies(),
    catch: () => new Error('Failed to get cookies')
  });

  // Filter down to steamrip cookies
  console.log('Cookies:', cookies);
  const steamripCookies = cookies.filter(cookie => cookie.domain.includes('steamrip.com'));
  const convertedCookies = convertPuppeteerCookies(steamripCookies);

  // Get user agent and other browser headers
  const userAgent = yield* Effect.tryPromise({
    try: () => page.evaluate(() => navigator.userAgent),
    catch: () => new Error('Failed to get user agent')
  });

  // Get additional headers by evaluating the page context
  const additionalHeaders = yield* Effect.tryPromise({
    try: () => page.evaluate(() => {
      // Try to get headers from any existing requests or the page context
      return {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        acceptLanguage: navigator.language || 'en-US,en;q=0.9',
        acceptEncoding: 'gzip, deflate, br',
        secFetchDest: 'document',
        secFetchMode: 'navigate',
        secFetchSite: 'none',
        secChUa: '"Google Chrome";v="119", "Chromium";v="119", "Not?A_Brand";v="24"',
        secChUaMobile: '?0',
        secChUaPlatform: '"macOS"'
      };
    }),
    catch: () => new Error('Failed to get additional headers')
  });

  // Merge captured headers with additional headers, prioritizing captured ones
  const mergedHeaders = { ...additionalHeaders, ...capturedHeaders };

  return {
    cookies: convertedCookies,
    userAgent,
    ...mergedHeaders
  };
});