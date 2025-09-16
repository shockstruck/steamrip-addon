import { DLService } from "./BaseService";
import { Effect } from "effect";
import { GofilePasswordRequiredError, GofileScrapeError } from "../errors";
import type { EventResponse, SearchResult } from "ogi-addon";

interface GofileApiResponse {
  status: string;
  data: {
    token?: string;
    id?: string;
    type?: string;
    name?: string;
    link?: string;
    children?: Record<string, GofileContent>;
    password?: string;
    passwordStatus?: string;
  };
}

interface GofileContent {
  id: string;
  type: 'file' | 'folder';
  name: string;
  link?: string;
  children?: Record<string, GofileContent>;
}

export default class GofileService extends DLService {
  private authToken: string | null = null;

  public constructor() {
    super('Gofile', 7);
  }

  scrapeDownloadLinks(
    url: string,
    event: EventResponse<SearchResult>
  ): Effect.Effect<
    { name: string; url: string; headers: Record<string, string> }[],
    GofilePasswordRequiredError | GofileScrapeError
  > {
    return Effect.gen(function* (this: GofileService) {
      // Extract content ID from URL
      const contentId = yield* this.extractContentId(url);
      
      // Get auth token
      yield* this.setAccountAccessToken();
      
      // Build file structure and collect download links
      const files = yield* this.buildContentStructure(contentId, url);
      
      return files;
    }.bind(this));
  }

  private extractContentId(url: string): Effect.Effect<string, GofileScrapeError> {
    return Effect.try({
      try: () => {
        const urlParts = url.split('/');
        if (urlParts.length < 2 || urlParts[urlParts.length - 2] !== 'd') {
          throw new Error(`The url probably doesn't have an id in it: ${url}`);
        }
        return urlParts[urlParts.length - 1];
      },
      catch: (error) => new GofileScrapeError({ url, error })
    });
  }

  private setAccountAccessToken(token?: string): Effect.Effect<void, GofileScrapeError> {
    return Effect.gen(function* (this: GofileService) {
      if (token) {
        this.authToken = token;
        return;
      }

      const response = yield* Effect.tryPromise({
        try: () => fetch('https://api.gofile.io/accounts', {
          method: 'POST',
          headers: {
            'Accept': '*/*',
            'User-Agent': 'Mozilla/5.0',
            'Connection': 'keep-alive',
            'Accept-Encoding': 'gzip'
          }
        }),
        catch: (error) => new GofileScrapeError({ url: 'https://api.gofile.io/accounts', error })
      });

      const data = yield* Effect.tryPromise({
        try: () => response.json() as Promise<GofileApiResponse>,
        catch: (error) => new GofileScrapeError({ url: 'https://api.gofile.io/accounts', error })
      });

      if (data.status !== 'ok' || !data.data.token) {
        return yield* Effect.fail(new GofileScrapeError({ 
          url: 'https://api.gofile.io/accounts', 
          error: new Error('Account creation failed!') 
        }));
      }

      this.authToken = data.data.token;
    }.bind(this));
  }

  private buildContentStructure(
    contentId: string, 
    originalUrl: string, 
    password?: string
  ): Effect.Effect<
    { name: string; url: string; headers: Record<string, string> }[],
    GofilePasswordRequiredError | GofileScrapeError
  > {
    return Effect.gen(function* (this: GofileService) {
      const files: { name: string; url: string; headers: Record<string, string> }[] = [];
      
      yield* this.collectFiles(contentId, originalUrl, files, password);
      
      return files;
    }.bind(this));
  }

  private collectFiles(
    contentId: string,
    originalUrl: string,
    files: { name: string; url: string; headers: Record<string, string> }[],
    password?: string
  ): Effect.Effect<void, GofilePasswordRequiredError | GofileScrapeError> {
    return Effect.gen(function* (this: GofileService) {
      let apiUrl = `https://api.gofile.io/contents/${contentId}?wt=4fd6sg89d7s6&cache=true&sortField=createTime&sortDirection=1`;
      
      if (password) {
        // Hash the password like in the Python version
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hashBuffer = yield* Effect.tryPromise({
          try: () => crypto.subtle.digest('SHA-256', data),
          catch: (error) => new GofileScrapeError({ url: originalUrl, error })
        });
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashedPassword = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        apiUrl += `&password=${hashedPassword}`;
      }

      const headers: Record<string, string> = {
        'Accept': '*/*',
        'User-Agent': 'Mozilla/5.0',
        'Connection': 'keep-alive',
        'Accept-Encoding': 'gzip'
      };

      if (this.authToken) {
        headers['Cookie'] = `accountToken=${this.authToken}`;
        headers['Authorization'] = `Bearer ${this.authToken}`;
      }

      const response = yield* Effect.tryPromise({
        try: () => fetch(apiUrl, { headers }),
        catch: (error) => new GofileScrapeError({ url: originalUrl, error })
      });

      const data = yield* Effect.tryPromise({
        try: () => response.json() as Promise<GofileApiResponse>,
        catch: (error) => new GofileScrapeError({ url: originalUrl, error })
      });

      if (data.status !== 'ok') {
        return yield* Effect.fail(new GofileScrapeError({ 
          url: originalUrl, 
          error: new Error(`Failed to fetch data from ${apiUrl}`) 
        }));
      }

      // Check for password protection
      if (data.data.password && data.data.passwordStatus !== 'passwordOk') {
        return yield* Effect.fail(new GofilePasswordRequiredError({ url: originalUrl }));
      }

      // If it's a file, add it to the collection
      if (data.data.type !== 'folder' && data.data.link) {
        files.push({
          name: data.data.name || 'unknown',
          url: data.data.link,
          headers: this.authToken ? {
            'Cookie': `accountToken=${this.authToken}`,
            'Authorization': `Bearer ${this.authToken}`
          } : {}
        });
        return;
      }

      // If it's a folder, process children
      if (data.data.children) {
        for (const child of Object.values(data.data.children)) {
          if (child.type === 'folder') {
            yield* this.collectFiles(child.id, originalUrl, files, password);
          } else if (child.link) {
            files.push({
              name: child.name,
              url: child.link,
              headers: this.authToken ? {
                'Cookie': `accountToken=${this.authToken}`,
                'Authorization': `Bearer ${this.authToken}`
              } : {}
            });
          }
        }
      }
    }.bind(this));
  }
}