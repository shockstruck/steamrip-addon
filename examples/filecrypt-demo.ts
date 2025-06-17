#!/usr/bin/env bun

import { 
  isFilecryptUrl, 
  processFilecryptUrl, 
  processFilecryptWithPrompt 
} from "../lib/filecrypt";
import { detectServiceFromUrl } from "../lib/services/matcher";

async function main() {
  // Process a real filecrypt URL if provided as command line argument
  const inputUrl = process.argv[2];
  
  if (inputUrl) {
    console.log(`\n=== Processing URL: ${inputUrl} ===`);
    
    if (isFilecryptUrl(inputUrl)) {
      try {
        console.log("Processing FileCrypt URL (headless, waiting for automatic redirect)...");
        const finalUrl = await processFilecryptWithPrompt(inputUrl);
        console.log(`\n✅ Success! Final download URL: ${finalUrl}`);
      } catch (error) {
        console.error(`❌ Error: ${error}`);
      }
    } else {
      console.log("❌ The provided URL is not a FileCrypt URL");
    }
  } else {
    console.log("\n💡 Usage: bun run filecrypt-demo <filecrypt-url>");
    console.log("   Example: bun run filecrypt-demo ....");
    console.log("\n🔄 This will run in headless mode and wait for automatic redirects (no user interaction needed)");
  }
}

main().catch(console.error); 