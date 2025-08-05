import { Effect } from "effect";
import { headerManager } from "../lib/header-manager";
import axios from "axios";

const testHeaders = async () => {
  console.log("Testing header functionality...");
  
  // Load headers
  await Effect.runPromise(headerManager.loadHeaders());
  
  // Set some test headers
  const testHeaderData = {
    cookies: [
      { name: 'cf_clearance', value: 'test_value', domain: 'steamrip.com' },
      { name: 'steamrip_session', value: 'test_session', domain: 'steamrip.com' }
    ],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    acceptLanguage: 'en-US,en;q=0.9',
    acceptEncoding: 'gzip, deflate, br',
    secFetchDest: 'document',
    secFetchMode: 'navigate',
    secFetchSite: 'none',
    secChUa: '"Google Chrome";v="119", "Chromium";v="119", "Not?A_Brand";v="24"',
    secChUaMobile: '?0',
    secChUaPlatform: '"macOS"'
  };
  
  await Effect.runPromise(headerManager.setHeaders(testHeaderData));
  
  // Get the header object
  const headers = headerManager.getHeaderObject();
  console.log("Generated headers:", JSON.stringify(headers, null, 2));
  
  // Test a request
  try {
    console.log("Testing request to steamrip.com...");
    const response = await axios.get('https://steamrip.com', { 
      headers,
      timeout: 10000,
      maxRedirects: 5
    });
    console.log("Response status:", response.status);
    console.log("Response headers:", response.headers);
    console.log("Content includes Cloudflare:", response.data.includes('Cloudflare'));
  } catch (error: any) {
    console.error("Request failed:", error.message);
    if (error.response) {
      console.log("Response status:", error.response.status);
      console.log("Response headers:", error.response.headers);
      console.log("Content includes Cloudflare:", error.response.data.includes('Cloudflare'));
    }
  }
};

testHeaders().catch(console.error); 