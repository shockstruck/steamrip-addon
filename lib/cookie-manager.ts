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

  loadHeaders(): Effect.Effect<void, FileSystemError> {
    return Effect.gen(function*(this: HeaderManager) {
      try {
        const data = yield* Effect.tryPromise({
          try: () => fs.readFile(this.headerFile, 'utf8'),
          catch: (error) => {
            console.error(error);
            return new FileSystemError({ path: this.headerFile, error })
          }
        });
        this.headerData = JSON.parse(data);
        // Ensure cookies array exists for backward compatibility
        if (!this.headerData.cookies) {
          this.headerData.cookies = [];
        }
      } catch (error) {
        // If file doesn't exist or is invalid, start with empty headers
        this.headerData = { cookies: [] };
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
    
    // Add other headers
    Object.entries(this.headerData).forEach(([key, value]) => {
      if (key !== 'cookies' && value !== undefined && value !== null) {
        headers[key] = String(value);
      }
    });
    
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