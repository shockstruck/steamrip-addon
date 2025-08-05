import { Effect } from "effect";
import * as fs from 'fs/promises';
import { FileSystemError } from './errors';

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface HeaderData {
  cookies: Cookie[];
  userAgent?: string;
  accept?: string;
  acceptLanguage?: string;
  acceptEncoding?: string;
  referer?: string;
  origin?: string;
  secFetchDest?: string;
  secFetchMode?: string;
  secFetchSite?: string;
  secChUa?: string;
  secChUaMobile?: string;
  secChUaPlatform?: string;
  [key: string]: any; // Allow for additional headers
}

class HeaderManager {
  private headerFile = 'steamrip-headers.json';
  private headerData: HeaderData = { cookies: [] };
  public requiresCloudflare: boolean = true;

  loadHeaders(): Effect.Effect<void, FileSystemError> {
    return Effect.gen(function*(this: HeaderManager) {
      const result = yield* Effect.either(
        Effect.tryPromise({
          try: () => fs.readFile(this.headerFile, 'utf8'),
          catch: (error) => new FileSystemError({ path: this.headerFile, error })
        })
      );
      
      if (result._tag === 'Left') {
        // If file doesn't exist or is invalid, start with empty headers
        this.headerData = { cookies: [] };
      } else {
        try {
          this.headerData = JSON.parse(result.right);
          // Ensure cookies array exists for backward compatibility
          if (!this.headerData.cookies) {
            this.headerData.cookies = [];
          }
        } catch (parseError) {
          // If JSON parsing fails, start with empty headers
          this.headerData = { cookies: [] };
        }
      }
    }.bind(this));
  }

  saveHeaders(): Effect.Effect<void, FileSystemError> {
    return Effect.gen(function*(this: HeaderManager) {
      yield* Effect.tryPromise({
        try: () => fs.writeFile(this.headerFile, JSON.stringify(this.headerData, null, 2)),
        catch: (error) => new FileSystemError({ path: this.headerFile, error })
      });
    }.bind(this));
  }

  setHeaders(newHeaderData: HeaderData): Effect.Effect<void, FileSystemError> {
    return Effect.gen(function*(this: HeaderManager) {
      // Merge new headers with existing ones
      this.headerData = { ...this.headerData, ...newHeaderData };
      
      // Handle cookies separately to avoid overwriting
      if (newHeaderData.cookies) {
        const cookieMap = new Map<string, Cookie>();
        
        // Add existing cookies
        this.headerData.cookies.forEach(cookie => {
          cookieMap.set(cookie.name, cookie);
        });
        
        // Add/update new cookies
        newHeaderData.cookies.forEach(cookie => {
          cookieMap.set(cookie.name, cookie);
        });
        
        this.headerData.cookies = Array.from(cookieMap.values());
      }
      
      yield* this.saveHeaders();
    }.bind(this));
  }

  getHeaders(): HeaderData {
    return { ...this.headerData };
  }

  getCookieString(): string {
    return this.headerData.cookies
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  getHeaderObject(): Record<string, string> {
    const headers: Record<string, string> = {};
    
    // Add cookies
    if (this.headerData.cookies.length > 0) {
      headers['Cookie'] = this.getCookieString();
    }
    
    // Add other headers with proper HTTP header capitalization
    Object.entries(this.headerData).forEach(([key, value]) => {
      if (key !== 'cookies' && value !== undefined && value !== null) {
        // Convert camelCase to proper HTTP header format
        const headerKey = key
          .replace(/([A-Z])/g, '-$1')
          .toLowerCase()
          .replace(/^-/, '')
          .split('-')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join('-');
        headers[headerKey] = String(value);
      }
    });

    // Add additional headers that are commonly required to bypass Cloudflare
    if (!headers['User-Agent'] && this.headerData.userAgent) {
      headers['User-Agent'] = this.headerData.userAgent;
    }
    
    // Ensure we have essential headers
    if (!headers['Accept']) {
      headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
    }
    
    if (!headers['Accept-Language']) {
      headers['Accept-Language'] = 'en-US,en;q=0.9';
    }
    
    if (!headers['Accept-Encoding']) {
      headers['Accept-Encoding'] = 'gzip, deflate, br';
    }
    
    if (!headers['Sec-Fetch-Dest']) {
      headers['Sec-Fetch-Dest'] = 'document';
    }
    
    if (!headers['Sec-Fetch-Mode']) {
      headers['Sec-Fetch-Mode'] = 'navigate';
    }
    
    if (!headers['Sec-Fetch-Site']) {
      headers['Sec-Fetch-Site'] = 'none';
    }
    
    if (!headers['Sec-Fetch-User']) {
      headers['Sec-Fetch-User'] = '?1';
    }
    
    if (!headers['Upgrade-Insecure-Requests']) {
      headers['Upgrade-Insecure-Requests'] = '1';
    }
    
    if (!headers['Cache-Control']) {
      headers['Cache-Control'] = 'max-age=0';
    }
    
    return headers;
  }

  clearHeaders(): Effect.Effect<void, FileSystemError> {
    return Effect.gen(function*(this: HeaderManager) {
      this.headerData = { cookies: [] };
      yield* this.saveHeaders();
    }.bind(this));
  }

  hasValidHeaders(): boolean {
    return this.headerData.cookies.length > 0;
  }

  hasValidCloudflareHeaders(): boolean {
    // Check for Cloudflare-specific cookies that indicate a successful solve
    const cloudflareCookies = this.headerData.cookies.filter(cookie => 
      cookie.name.includes('cf_') || 
      cookie.name.includes('__cf') ||
      cookie.name.includes('cloudflare') ||
      cookie.name === 'cf_clearance'
    );
    return cloudflareCookies.length > 0;
  }

  // Backward compatibility methods
  setCookies(newCookies: Cookie[]): Effect.Effect<void, FileSystemError> {
    return this.setHeaders({ cookies: newCookies });
  }

  getCookies(): Cookie[] {
    return [...this.headerData.cookies];
  }

  clearCookies(): Effect.Effect<void, FileSystemError> {
    return this.clearHeaders();
  }

  hasValidCookies(): boolean {
    return this.hasValidHeaders();
  }
}

// Create a singleton instance
export const headerManager = new HeaderManager();
export const cookieManager = headerManager; // Backward compatibility

// Helper function to convert Puppeteer cookies to our format
export const convertPuppeteerCookies = (puppeteerCookies: any[]): Cookie[] => {
  return puppeteerCookies.map(cookie => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite
  }));
}; 