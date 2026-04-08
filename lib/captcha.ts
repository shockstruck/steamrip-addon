import type { Page } from "puppeteer";
import readline from "readline";
import { connectRealBrowser, navigateBrowserPage } from "./services/BaseService";
import { showInfoPopup } from "./popup-utils";

/**
 * Shows an informational popup explaining what will happen with CLI captcha solving
 */
async function showCaptchaCliInfoPopup(pageUrl: string, siteKey: string | null): Promise<void> {
  const infoBox = [
    { label: "Page", value: pageUrl }
  ];
  
  if (siteKey) {
    infoBox.push({ label: "Site Key", value: siteKey });
  }
  
  await showInfoPopup({
    title: "reCAPTCHA Detected",
    icon: "🛡️",
    message: "A captcha challenge has been detected and needs to be solved manually.",
    infoBox,
    steps: [
      "We will open the page in a new browser window",
      "Complete the reCAPTCHA challenge on that page",
      "We will take care of the rest."
    ],
    buttonText: "Continue",
    testModeMessage: "Test Mode: This popup will close automatically"
  });
}

/**
 * Shows an informational popup explaining what will happen with popup captcha solving
 */
async function showCaptchaPopupInfoPopup(pageUrl: string, siteKey: string | null): Promise<void> {
  const infoBox = [
    { label: "Page", value: pageUrl }
  ];
  
  if (siteKey) {
    infoBox.push({ label: "Site Key", value: siteKey });
  }
  
  await showInfoPopup({
    title: "reCAPTCHA Popup Mode",
    icon: "🪟",
    message: "A focused captcha window will open for easier solving.",
    infoBox,
    steps: [
      "A clean browser window will open showing only the captcha",
      "Complete the reCAPTCHA challenge in that window",
      "The window will close automatically when solved",
      "Processing will continue automatically"
    ],
    footerNote: "✨ This method provides a cleaner, distraction-free captcha experience",
    buttonText: "Open Captcha Window",
    testModeMessage: "Test Mode: This popup will close automatically"
  });
}

/**
 * Prompts the CLI user to manually solve a visible Google reCAPTCHA challenge and provide the resulting token.
 *
 * The helper will try to detect the first `<div class="g-recaptcha" data-sitekey="...">` element on the page and show
 * the user its site-key together with the current page URL. The user can then use any approach – e.g. opening the
 * page in a regular browser session – to solve the captcha and copy the value of the `g-recaptcha-response` field.
 *
 * Once the user pastes the value in the terminal, the function injects it into the Puppeteer-controlled page so that
 * the following request / form submission can succeed.
 *
 * The function finally returns the provided token so callers can use it in API calls if they need to.
 */
export async function promptForRecaptchaToken(page: Page): Promise<string> {
  // Attempt to grab the site-key from a typical Google reCAPTCHA element.
  const siteKey: string | null = await page.evaluate(() => {
    const el = document.querySelector<HTMLDivElement>('div.g-recaptcha[data-sitekey]');
    return el?.getAttribute('data-sitekey') ?? null;
  });

  // Show informational popup first
  await showCaptchaCliInfoPopup(page.url(), siteKey);

  console.log("\n[steamrip-addon] Captcha detected!");
  console.log(` › Page: ${page.url()}`);
  if (siteKey) {
    console.log(` › reCAPTCHA site-key: ${siteKey}`);
  }
  console.log(
    "Please solve the captcha in your browser (or with any external service) and paste the resulting token (g-recaptcha-response) below.\n" +
      "If you leave the input empty and press ENTER the operation will be aborted."
  );

  const token = await readLineQuestion("Captcha token: ");

  if (!token) {
    throw new Error("No captcha token provided – aborting.");
  }

  // Inject the token into the page so that subsequent form submissions succeed.
  await page.evaluate((t) => {
    // There can be multiple response textareas – fill all of them just to be safe.
    const textareas = document.querySelectorAll<HTMLTextAreaElement>(
      'textarea[name="g-recaptcha-response"], #g-recaptcha-response'
    );
    textareas.forEach((ta) => {
      ta.value = t;
      // Some sites rely on an input event to detect changes.
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }, token);

  console.log("Captcha token injected – continuing …\n");

  return token;
}

/**
 * Utility that returns a Promise resolving with the user's CLI input for the given prompt.
 */
function readLineQuestion(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Opens a visible Chromium window (non–headless) on the same URL so the user can solve the captcha
 * through the familiar browser UI. Once the `g-recaptcha-response` token is detected the window closes
 * and the token is injected back into the original (potentially headless) page.
 *
 * This is ideal for background-running processes where terminal interaction is not possible.
 */
export async function solveRecaptchaWithPopup(page: Page): Promise<string> {
  // Ensure we are dealing with a reCAPTCHA first.
  const siteKey: string | null = await page.evaluate(() => {
    const el = document.querySelector<HTMLDivElement>('div.g-recaptcha[data-sitekey]');
    return el?.getAttribute('data-sitekey') ?? null;
  });

  if (!siteKey) {
    throw new Error("No visible reCAPTCHA widget found on the page – cannot open popup.");
  }

  // Show informational popup first
  await showCaptchaPopupInfoPopup(page.url(), siteKey);

  console.log("[steamrip-addon] Opening a clean captcha window for you to solve ...");

  // Launch a fresh Chromium instance with a clean, minimal UI
  const conn = await connectRealBrowser({
    headless: false,
    defaultViewport: { width: 400, height: 550 },
    args: [
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-extensions',
      '--disable-plugins',
      '--disable-background-mode',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-field-trial-config',
      '--disable-ipc-flooding-protection',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      '--disable-notifications',
      '--disable-translate',
      '--disable-component-extensions-with-background-pages',
      '--window-size=450,600',
      '--window-position=100,100'
    ]
  });
  const { browser, page: popupPage } = conn;
  
  // Set up browser closure detection
  let browserClosed = false;
  
  browser.on('disconnected', () => {
    browserClosed = true;
  });

  popupPage.on('close', () => {
    browserClosed = true;
  });
  
  try {
    const activePopupPage = await navigateBrowserPage(browser as any, popupPage as any, page.url(), { waitUntil: "networkidle2" });

    // Wait a bit more for the page to fully load, then inject styles
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check if browser was closed during loading
    if (browserClosed || activePopupPage.isClosed()) {
      throw new Error("Captcha browser window was closed by user");
    }
    
    // Inject CSS to hide everything except the captcha and add some styling
    await activePopupPage.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = `
        /* Hide everything by default */
        body * {
          visibility: hidden !important;
        }
        
        /* Show only the captcha container and its children */
        .g-recaptcha,
        .g-recaptcha *,
        iframe[src*="recaptcha"] {
          visibility: visible !important;
        }
        
        /* Clean up the page styling */
        body {
          margin: 0 !important;
          padding: 20px !important;
          background: #f5f5f5 !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          visibility: visible !important;
        }
        
        /* Center the captcha */
        .g-recaptcha {
          margin: 20px auto !important;
          display: block !important;
        }
        
        /* Add a helpful header */
        body::before {
          content: "Please solve the reCAPTCHA below to continue" !important;
          display: block !important;
          text-align: center !important;
          padding: 10px !important;
          margin-bottom: 20px !important;
          background: #4285f4 !important;
          color: white !important;
          border-radius: 4px !important;
          font-size: 14px !important;
          font-weight: 500 !important;
          visibility: visible !important;
        }
        
        /* Hide any other page content that might be visible */
        header, nav, footer, .header, .nav, .footer,
        .sidebar, .menu, .navigation, .ads, .advertisement {
          display: none !important;
        }
        
        /* Ensure captcha iframe is properly sized */
        iframe[src*="recaptcha"] {
          border: none !important;
          border-radius: 4px !important;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1) !important;
        }
      `;
      document.head.appendChild(style);
      console.log('injected styles');
    });

    // Wait for the token to appear (Google injects it into a hidden textarea once solved).
    await activePopupPage.waitForFunction(
      () => {
        const ta = document.querySelector<HTMLTextAreaElement>(
          'textarea[name="g-recaptcha-response"], #g-recaptcha-response'
        );
        return ta && ta.value.length > 0;
      },
      {
        polling: 500,
        timeout: 0, // wait indefinitely until the user completes the captcha
      }
    );

    // Check if browser was closed during captcha solving
    if (browserClosed || activePopupPage.isClosed()) {
      throw new Error("Captcha browser window was closed by user");
    }

    const token: string = await activePopupPage.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(
        'textarea[name="g-recaptcha-response"], #g-recaptcha-response'
      );
      return ta?.value ?? "";
    });

    // Propagate the token back into the original page so automation can resume.
    await page.evaluate((t) => {
      const textareas = document.querySelectorAll<HTMLTextAreaElement>(
        'textarea[name="g-recaptcha-response"], #g-recaptcha-response'
      );
      textareas.forEach((ta) => {
        ta.value = t;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }, token);

    console.log("[steamrip-addon] Captcha solved and token injected – continuing …");

    return token;

  } catch (error) {
    if (browserClosed || popupPage.isClosed()) {
      throw new Error("Captcha browser window was closed by user");
    }
    throw error;
  } finally {
    await browser.close();
  }
}
