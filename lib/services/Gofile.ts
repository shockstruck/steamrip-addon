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
  private websiteToken: string | null = null;

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
      
      // Get auth token and website token
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

  /**
   * Matches the reference implementation (see gofile-downloader generate_website_token):
   * sha256(f"{user_agent}::en-US::{account_token}::{time_slot}::5d4f7g8sd45fsd").hexdigest()
   *
   * where time_slot = int(time()) // 14400.
   */
  private generateWebsiteToken(
    userAgent: string,
    accountToken: string,
    errorUrl: string,
  ): Effect.Effect<string, GofileScrapeError> {
    return Effect.tryPromise({
      try: async () => {
        const timeSlot = Math.floor(Math.floor(Date.now() / 1000) / 14400);
        const raw = `${userAgent}::en-US::${accountToken}::${timeSlot}::5d4f7g8sd45fsd`;

        const encoder = new TextEncoder();
        const data = encoder.encode(raw);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
      },
      catch: (error) => new GofileScrapeError({ url: errorUrl, error }),
    });
  }

  private setAccountAccessToken(token?: string): Effect.Effect<void, GofileScrapeError> {
    return Effect.gen(function* (this: GofileService) {
      if (token) {
        this.authToken = token;
        return;
      }

      // GoFile rate-limits token creation as well. Retry a few times on 429 / error-rateLimit.
      const maxRetries = 6;
      const baseDelayMs = 1000;
      const accountsUrl = 'https://api.gofile.io/accounts';
      const userAgent = 'Mozilla/5.0';
      const websiteAccountToken = ''; // Python uses generate_website_token(user_agent, "") for account creation.

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const websiteToken = yield* this.generateWebsiteToken(
          userAgent,
          websiteAccountToken,
          accountsUrl
        );

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(accountsUrl, {
              method: 'POST',
              headers: {
                Accept: '*/*',
                'User-Agent': userAgent,
                Connection: 'keep-alive',
                'Accept-Encoding': 'gzip',
                Origin: 'https://gofile.io',
                Referer: 'https://gofile.io/',
                'X-Website-Token': websiteToken,
                'X-BL': 'en-US',
              },
            }),
          catch: (error) =>
            new GofileScrapeError({
              url: accountsUrl,
              error,
            }),
        });

        const data = yield* Effect.tryPromise({
          try: () => response.json() as Promise<GofileApiResponse>,
          catch: (error) =>
            new GofileScrapeError({
              url: 'https://api.gofile.io/accounts',
              error,
            }),
        });

        if (data.status === 'ok' && data.data.token) {
          this.authToken = data.data.token;
          return;
        }

        const isRateLimited =
          response.status === 429 || data.status === 'error-rateLimit';

        if (isRateLimited && attempt < maxRetries) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterSeconds = retryAfterHeader
            ? Number.parseInt(retryAfterHeader, 10)
            : NaN;

          const backoffMs = Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds * 1000
            : Math.pow(2, attempt) * baseDelayMs;

          const jitterMs = Math.floor(Math.random() * 250);
          yield* Effect.sleep(backoffMs + jitterMs);
          continue;
        }

        return yield* Effect.fail(
          new GofileScrapeError({
            url: accountsUrl,
            error: new Error(
              `Account creation failed (status=${data.status}, http=${response.status})`
            ),
          })
        );
      }
    }.bind(this));
  }

  private fetchWebsiteToken(): Effect.Effect<void, GofileScrapeError> {
    return Effect.gen(function* (this: GofileService) {
      if (this.websiteToken) {
        return;
      }

      const response = yield* Effect.tryPromise({
        try: () => fetch('https://gofile.io/dist/js/config.js', {
          headers: {
            'Accept': '*/*',
            'User-Agent': 'Mozilla/5.0',
          }
        }),
        catch: (error) => new GofileScrapeError({ url: 'https://gofile.io/dist/js/config.js', error })
      });

      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (error) => new GofileScrapeError({ url: 'https://gofile.io/dist/js/config.js', error })
      });

      // Extract website token from: .wt = "TOKEN"
      const match = text.match(/\.wt\s*=\s*["']([^"']+)["']/);
      if (!match || !match[1]) {
        return yield* Effect.fail(new GofileScrapeError({
          url: 'https://gofile.io/dist/js/config.js',
          error: new Error('Failed to extract website token from config.js')
        }));
      }

      this.websiteToken = match[1];
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
      const userAgent = 'Mozilla/5.0';
      let apiUrl = `https://api.gofile.io/contents/${contentId}?cache=true&sortField=createTime&sortDirection=1`;
      
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

      const baseHeaders: Record<string, string> = {
        'Accept': '*/*',
        'User-Agent': userAgent,
        'Connection': 'keep-alive',
        'Accept-Encoding': 'gzip',
        Origin: 'https://gofile.io',
        Referer: 'https://gofile.io/',
        'X-BL': 'en-US',
      };

      if (this.authToken) {
        baseHeaders['Cookie'] = `accountToken=${this.authToken}`;
        baseHeaders['Authorization'] = `Bearer ${this.authToken}`;
      }

      // GoFile rate-limits aggressively; retry a few times on 429 / error-rateLimit.
      const maxRetries = 6;
      const baseDelayMs = 1000;
      let data: GofileApiResponse | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const websiteToken = yield* this.generateWebsiteToken(
          userAgent,
          this.authToken ?? '',
          originalUrl,
        );

        const headers: Record<string, string> = {
          ...baseHeaders,
          'X-Website-Token': websiteToken,
        };

        const response = yield* Effect.tryPromise({
          try: () => fetch(apiUrl, { headers }),
          catch: (error) => new GofileScrapeError({ url: originalUrl, error })
        });

        // Try to parse the response body for better diagnostics / retry decisions.
        const parsedBody = yield* Effect.tryPromise({
          try: async () => {
            try {
              return (await response.json()) as GofileApiResponse;
            } catch {
              return null;
            }
          },
          catch: (error) => new GofileScrapeError({ url: originalUrl, error })
        }).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        );

        const isRateLimited =
          response.status === 429 ||
          parsedBody?.status === 'error-rateLimit';

        if (parsedBody?.status === 'ok') {
          data = parsedBody;
          break;
        }

        if (isRateLimited && attempt < maxRetries) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterSeconds = retryAfterHeader
            ? Number.parseInt(retryAfterHeader, 10)
            : NaN;

          const backoffMs = Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds * 1000
            : Math.pow(2, attempt) * baseDelayMs;

          // Add a small jitter so concurrent tests don't synchronize.
          const jitterMs = Math.floor(Math.random() * 250);
          yield* Effect.sleep(backoffMs + jitterMs);
          continue;
        }

        // Not rate-limited (or out of retries) => fail with the most helpful info we have.
        return yield* Effect.fail(
          new GofileScrapeError({
            url: originalUrl,
            error: new Error(
              `Failed to fetch data from ${apiUrl} (status=${parsedBody?.status ?? response.status})`
            )
          })
        );
      }

      if (!data) {
        return yield* Effect.fail(
          new GofileScrapeError({
            url: originalUrl,
            error: new Error(`No data received from ${apiUrl}`)
          })
        );
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
            'Authorization': `Bearer ${this.authToken}`,
            Origin: 'https://gofile.io',
            Referer: 'https://gofile.io/',
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
                'Authorization': `Bearer ${this.authToken}`,
                Origin: 'https://gofile.io',
                Referer: 'https://gofile.io/',
                'OGI-Parallel-Limit': '1'
              } : {}
            });
          }
        }
      }
    }.bind(this));
  }
}