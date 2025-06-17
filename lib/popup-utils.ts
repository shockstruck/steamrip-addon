import puppeteer from "puppeteer-extra";
import { PUPPETEER_OPTIONS } from "./services/BaseService";

export interface PopupConfig {
  title: string;
  icon: string;
  message: string;
  infoBox?: { label: string; value: string }[];
  steps: string[];
  footerNote?: string;
  buttonText: string;
  windowSize?: { width: number; height: number };
  testModeMessage?: string;
}

/**
 * Shows an informational popup with configurable content
 */
export async function showInfoPopup(config: PopupConfig): Promise<void> {
  console.log(`[popup] Opening information dialog: ${config.title}`);
  
  // Detect if we're in a test environment
  const isTestEnvironment = process.env.NODE_ENV === 'test' || 
                           process.env.BUN_TEST === '1' || 
                           typeof (global as any).it !== 'undefined' ||
                           typeof (global as any).describe !== 'undefined';
  
  const windowSize = config.windowSize || { width: 500, height: 400 };
  
  const browser = await puppeteer.launch({
    ...PUPPETEER_OPTIONS,
    headless: false,
    args: [
      ...(PUPPETEER_OPTIONS?.args || []),
      `--window-size=${windowSize.width},${windowSize.height}`,
      '--window-position=200,200'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport(windowSize);

  // Set up browser closure detection
  let browserClosed = false;
  
  browser.on('disconnected', () => {
    browserClosed = true;
  });

  page.on('close', () => {
    browserClosed = true;
  });

  // Create simple HTML content
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${config.title}</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
          margin: 0;
          padding: 24px;
          background: white;
          color: #333;
          line-height: 1.5;
        }
        .container {
          max-width: 100%;
          background: white;
          border: 1px solid #ddd;
          border-radius: 8px;
          padding: 24px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        h1 {
          margin: 0 0 16px 0;
          font-size: 18px;
          font-weight: 600;
          color: #222;
          display: flex;
          align-items: center;
        }
        .icon {
          margin-right: 8px;
        }
        .message {
          margin-bottom: 16px;
          color: #555;
        }
        .info-box {
          background: #f8f9fa;
          border: 1px solid #e9ecef;
          border-radius: 4px;
          padding: 12px;
          margin: 16px 0;
          font-size: 14px;
        }
        .info-line {
          margin: 4px 0;
        }
        .info-label {
          font-weight: 500;
          color: #333;
        }
        .info-value {
          color: #666;
          font-family: monospace;
          font-size: 13px;
          word-break: break-all;
        }
        .steps {
          margin: 20px 0;
        }
        .step {
          margin: 12px 0;
          display: flex;
          align-items: flex-start;
        }
        .step-number {
          background: #007bff;
          color: white;
          border-radius: 50%;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-right: 12px;
          font-size: 12px;
          font-weight: 500;
          flex-shrink: 0;
          margin-top: 2px;
        }
        .step-text {
          color: #555;
        }
        .footer-note {
          font-size: 13px;
          color: #666;
          margin: 16px 0;
          padding: 8px 12px;
          background: #f8f9fa;
          border-radius: 4px;
          border-left: 3px solid #007bff;
        }
        .continue-btn {
          background: #007bff;
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 4px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          margin-top: 20px;
          width: 100%;
        }
        .continue-btn:hover {
          background: #0056b3;
        }
        .test-mode {
          background: #fff3cd;
          border: 1px solid #ffeaa7;
          color: #856404;
          padding: 8px 12px;
          border-radius: 4px;
          margin: 12px 0;
          font-size: 13px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1><span class="icon">${config.icon}</span>${config.title}</h1>
        <div class="message">${config.message}</div>
        
        ${config.infoBox ? `
          <div class="info-box">
            ${config.infoBox.map(item => 
              `<div class="info-line">
                <span class="info-label">${item.label}:</span><br>
                <span class="info-value">${item.value}</span>
              </div>`
            ).join('')}
          </div>
        ` : ''}
        
        ${isTestEnvironment && config.testModeMessage ? 
          `<div class="test-mode">🧪 ${config.testModeMessage}</div>` : ''}
        
        <div class="steps">
          ${config.steps.map((step, index) => 
            `<div class="step">
              <div class="step-number">${index + 1}</div>
              <div class="step-text">${step}</div>
            </div>`
          ).join('')}
        </div>
        
        ${config.footerNote ? 
          `<div class="footer-note">${config.footerNote}</div>` : ''}
        
        <button class="continue-btn" onclick="window.close()">${config.buttonText}</button>
      </div>
    </body>
    </html>
  `;

  await page.setContent(htmlContent);
  
  try {
    await page.waitForFunction(() => !document.body, { timeout: 0 });
  } catch (error) {
    if (browserClosed || page.isClosed()) {
      throw new Error(`User cancelled operation by closing ${config.title} dialog`);
    }
    console.log(`[popup] Popup interaction completed or timed out`);
  } finally {
    await browser.close();
  }
  
  console.log(`[popup] User confirmed - continuing...`);
} 