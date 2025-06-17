import puppeteer from "puppeteer-extra";
import { DLService, PUPPETEER_OPTIONS } from "./BaseService";
import stealth from "puppeteer-extra-plugin-stealth";
import adblock from "puppeteer-extra-plugin-adblocker";

export default class FischierService extends DLService {
  public constructor() {
    super('Fischier', 10);
  }

  async scrapeDownloadLinks(url: string) {
    puppeteer.use(stealth());
    puppeteer.use(adblock());
    // clear the cookies

    const browser = await puppeteer.launch(
      PUPPETEER_OPTIONS,
    );
    await browser.deleteCookie();
    const page = await browser.newPage();
    await page.goto(url);
    // send submit to the form with class alc
    await page.evaluate(() => {
      const form: HTMLFormElement | null = document.querySelector('form.alc');
      if (!form) {
        throw new Error('Form not found');
      }
      form.submit();
    });
    await page.screenshot({ path: 'page.png' });

    // wait for the page to load
    await page.waitForNavigation();

    // Handle countdown scenario if the page has a flip clock
    const hasCountdown = await page.evaluate(() => {
      return document.querySelector(".flip-clock-wrapper") !== null;
    });

    if (hasCountdown) {
      console.log('Countdown detected, handling timer...');
      await page.evaluate(() => {
        return new Promise<void>((resolve) => {
          // Step 1: Extract digits from the clock
          const clock = document.querySelectorAll(".flip-clock-wrapper ul.flip");
          if (clock.length !== 2) {
            console.warn("Clock not found or not in expected format.");
            resolve();
            return;
          }

          const tensElement = clock[0]?.querySelector(".flip-clock-active .inn");
          const onesElement = clock[1]?.querySelector(".flip-clock-active .inn");
          
          if (!tensElement || !onesElement) {
            console.warn("Clock elements not found.");
            resolve();
            return;
          }

          const tens = tensElement.textContent?.trim();
          const ones = onesElement.textContent?.trim();
          
          if (!tens || !ones) {
            console.warn("Clock text content not found.");
            resolve();
            return;
          }

          const countdownStart = parseInt(tens + ones, 10);

          if (isNaN(countdownStart)) {
            console.warn("Couldn't extract countdown digits.");
            resolve();
            return;
          }

          // Step 2: Replace the flip clock with a simple countdown
          const newTimer = document.createElement("div");
          newTimer.id = "local-countdown";
          newTimer.style.cssText = "font-size: 24px; text-align: center; margin-top: 20px;";
          newTimer.textContent = `Please wait ${countdownStart} seconds...`;
          const wrapper = document.querySelector(".flip-clock-wrapper");
          if (wrapper) wrapper.replaceWith(newTimer);

          // Step 3: Start the countdown
          let seconds = countdownStart;
          const interval = setInterval(() => {
            seconds--;
            if (seconds <= 0) {
              clearInterval(interval);
              newTimer.textContent = "Ready to download!";
              const dlw = document.getElementById("dlw");
              const dlb = document.getElementById("dlb");
              if (dlw) dlw.style.display = "none";
              if (dlb) dlb.style.display = "block";
              resolve();
            } else {
              newTimer.textContent = `Please wait ${seconds} seconds...`;
            }
          }, 1000);
        });
      });

      // now click on the button with the id dlb
      await page.evaluate(() => {
        const button = document.getElementById('dlb');
        if (button) button.click();
      });

      await page.waitForNavigation();
    }

    // check if the anchor element with class ok, btn-general, and btn-orange exists, and if so, get the href
    const okButton = await page.$('a.ok.btn-general.btn-orange');
    if (okButton) {
      const href = await okButton.evaluate(el => el.getAttribute('href'));
      if (href) {
        console.log('found ok button', href);
        await browser.close();
        return [{ url: href, name: 'Fischier' }];
      }
    }

    await browser.close();
    return [];
  }
}