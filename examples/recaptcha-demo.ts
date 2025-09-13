import { solveRecaptchaWithPopup } from "../lib/captcha";
import { PUPPETEER_OPTIONS } from "../lib/services/BaseService";
import type { Page } from "puppeteer";
import { connect } from "puppeteer-real-browser";

async function solveCaptchaAndSubmit(page: Page) {
  console.log("[recaptcha-demo] Navigated to demo page.");
  const token = await solveRecaptchaWithPopup(page);
  console.log(`[recaptcha-demo] Captcha solved, token: ${token.slice(0, 20)}...`);

  // The token is injected, now we can submit the form.
  await page.click("input[type=submit]");
  console.log("[recaptcha-demo] Form submitted.");

  await page.waitForNavigation({ waitUntil: "networkidle0" });
  console.log("[recaptcha-demo] Page reloaded.");

  // You can now interact with the page after the captcha is solved.
  // For this demo, we'll just take a screenshot of the result page.
  const content = await page.content();
  if (content.includes("Verification Success")) {
    console.log("[recaptcha-demo] Verification successful!");
  } else {
    console.log("[recaptcha-demo] Verification might have failed.");
  }

  await page.screenshot({ path: "recaptcha-success.png" });
  console.log("[recaptcha-demo] Screenshot saved to recaptcha-success.png");
}

async function main() {
  const { browser, page } = await connect({ headless: PUPPETEER_OPTIONS.headless, args: PUPPETEER_OPTIONS.args });
  try {
    await page.goto("https://www.google.com/recaptcha/api2/demo", {
      waitUntil: "networkidle2",
    });
    await solveCaptchaAndSubmit(page);
  } catch (error) {
    console.error("[recaptcha-demo] An error occurred:", error);
    await page.screenshot({ path: "recaptcha-error.png" });
  } finally {
    await browser.close();
  }
}

main(); 