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
  type: "file" | "folder";
  name: string;
  link?: string;
}

export type GofileDownloadLink = {
  name: string;
  url: string;
  headers: Record<string, string>;
};

const GOFILE_ORIGIN = "https://gofile.io";
const GOFILE_API = "https://api.gofile.io";
// Salt used in the dynamic X-Website-Token SHA-256 hash, matching
// ltsdw/gofile-downloader's `generate_website_token` exactly.
const WEBSITE_TOKEN_SALT = "9844d94d963d30";
const DEFAULT_USER_AGENT = "Mozilla/5.0";
const MAX_RETRIES = Number.parseInt(process.env.GF_MAX_RETRIES ?? "5", 10);
const REQUEST_TIMEOUT_MS = Number.parseFloat(process.env.GF_TIMEOUT ?? "15") * 1000;
// GF_DOWNLOAD_DIR is forwarded to the OGI host so it writes files in the right
// place — the service itself doesn't perform downloads.
const DOWNLOAD_DIR = process.env.GF_DOWNLOAD_DIR ?? "";

function getUserAgent(): string {
  return process.env.GF_USERAGENT ?? DEFAULT_USER_AGENT;
}

function getSessionHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept-Encoding": "gzip",
    "User-Agent": getUserAgent(),
    Connection: "keep-alive",
    Accept: "*/*",
    Origin: GOFILE_ORIGIN,
    Referer: `${GOFILE_ORIGIN}/`,
  };

  if (authToken) {
    headers.Cookie = `accountToken=${authToken}`;
    headers.Authorization = `Bearer ${authToken}`;
  }

  return headers;
}

/**
 * Headers attached to every file entry that tell the OGI host how to actually
 * fetch the file. The service itself does not perform downloads.
 *   - X-OGI-Download-Dir: where the file should land (from GF_DOWNLOAD_DIR)
 *   - OGI-Parallel-Limit: 1 — gofile disallows parallel connections per file
 */
function downloadRoutingHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "OGI-Parallel-Limit": "1",
  };
  if (DOWNLOAD_DIR) {
    headers["X-OGI-Download-Dir"] = DOWNLOAD_DIR;
  }
  return headers;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Matches gofile-downloader `generate_website_token`:
 * sha256(f"{user_agent}::en-US::{account_token}::{time_slot}::{salt}")
 * where time_slot = floor(unix_time / 14400).
 *
 * The optional `nowSeconds` parameter is exposed for tests; production
 * callers should leave it unset so the real current time is used.
 */
export async function generateWebsiteToken(
  userAgent: string,
  accountToken: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const timeSlot = Math.floor(nowSeconds / 14400);
  const raw = `${userAgent}::en-US::${accountToken}::${timeSlot}::${WEBSITE_TOKEN_SALT}`;
  return sha256Hex(raw);
}

/**
 * Sanitises a single path segment the way the upstream Python script does:
 *   - replace path separators with `_`
 *   - strip ASCII control characters
 *   - strip characters illegal on Windows (`<>:"/\|?*`)
 *   - strip leading/trailing whitespace and dots
 *   - fall back to `unnamed` when the result would be empty
 */
export function sanitizePathSegment(name: string): string {
  let sanitized = name
    .replace(/[/\\]/g, "_")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();

  if (!sanitized) {
    sanitized = "unnamed";
  }

  return sanitized;
}

export function resolveNamingCollision(
  pathingCount: Map<string, number>,
  parentPath: string,
  childName: string,
  isDir = false,
): string {
  const sanitizedChild = sanitizePathSegment(childName);
  const safeParent = parentPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const filepath = safeParent
    ? `${safeParent}/${sanitizedChild}`
    : sanitizedChild;

  const count = pathingCount.get(filepath) ?? 0;
  pathingCount.set(filepath, count + 1);

  if (count === 0) {
    return filepath;
  }

  if (isDir) {
    return `${filepath}(${count})`;
  }

  const dotIndex = sanitizedChild.lastIndexOf(".");
  if (dotIndex <= 0) {
    return `${filepath}(${count})`;
  }

  return `${safeParent}/${sanitizedChild.slice(0, dotIndex)}(${count})${sanitizedChild.slice(dotIndex)}`;
}

export default class GofileService extends DLService {
  private authToken: string | null = null;

  public constructor() {
    super("Gofile", 10);
  }

  scrapeDownloadLinks(
    url: string,
    _event: EventResponse<SearchResult>,
    password?: string,
  ): Effect.Effect<
    GofileDownloadLink[],
    GofilePasswordRequiredError | GofileScrapeError
  > {
    return Effect.gen(function* (this: GofileService) {
      const contentId = yield* this.extractContentId(url);
      yield* this.setAccountAccessToken(process.env.GF_TOKEN);

      const hashedPassword = password
        ? yield* Effect.tryPromise({
            try: () => sha256Hex(password),
            catch: (error) => new GofileScrapeError({ url, error }),
          })
        : undefined;

      const files: GofileDownloadLink[] = [];
      const pathingCount = new Map<string, number>();

      yield* this.buildContentTree(
        "",
        contentId,
        contentId,
        url,
        files,
        pathingCount,
        hashedPassword,
        true,
      );

      return files;
    }.bind(this));
  }

  private extractContentId(url: string): Effect.Effect<string, GofileScrapeError> {
    return Effect.try({
      try: () => {
        const urlParts = url.split("/").filter((segment) => segment.length > 0);
        if (urlParts.length < 2 || urlParts[urlParts.length - 2] !== "d") {
          throw new Error(`The url probably doesn't have an id in it: ${url}`);
        }
        return urlParts[urlParts.length - 1]!;
      },
      catch: (error) => new GofileScrapeError({ url, error }),
    });
  }

  private getDownloadHeaders(): Record<string, string> {
    return this.authToken ? getSessionHeaders(this.authToken) : {};
  }

  private setAccountAccessToken(
    token?: string,
  ): Effect.Effect<void, GofileScrapeError> {
    return Effect.gen(function* (this: GofileService) {
      if (token) {
        this.authToken = token;
        return;
      }

      const accountsUrl = `${GOFILE_API}/accounts`;
      const userAgent = getUserAgent();

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const websiteToken = yield* Effect.tryPromise({
          try: () => generateWebsiteToken(userAgent, ""),
          catch: (error) => new GofileScrapeError({ url: accountsUrl, error }),
        });

        const response = yield* this.fetchWithRetries(accountsUrl, {
          method: "POST",
          headers: {
            ...getSessionHeaders(),
            "X-Website-Token": websiteToken,
            "X-BL": "en-US",
          },
        });

        if (!response) {
          if (attempt < MAX_RETRIES) continue;
          return yield* Effect.fail(
            new GofileScrapeError({
              url: accountsUrl,
              error: new Error("Account creation failed: no response"),
            }),
          );
        }

        const data = yield* Effect.tryPromise({
          try: () => response.json() as Promise<GofileApiResponse>,
          catch: (error) =>
            new GofileScrapeError({ url: accountsUrl, error }),
        });

        if (data.status === "ok" && data.data.token) {
          this.authToken = data.data.token;
          return;
        }

        const isRateLimited =
          response.status === 429 || data.status === "error-rateLimit";

        if (isRateLimited && attempt < MAX_RETRIES) {
          yield* this.sleepForRetry(response, attempt);
          continue;
        }

        return yield* Effect.fail(
          new GofileScrapeError({
            url: accountsUrl,
            error: new Error(
              `Account creation failed (status=${data.status}, http=${response.status})`,
            ),
          }),
        );
      }
    }.bind(this));
  }

  private fetchWithRetries(
    url: string,
    init: RequestInit,
  ): Effect.Effect<Response | null, never> {
    return Effect.gen(function* () {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(url, {
              ...init,
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }),
          catch: () => null,
        }).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (response) {
          return response;
        }

        if (attempt < MAX_RETRIES) {
          yield* Effect.sleep(Math.pow(2, attempt) * 1000);
        }
      }

      return null;
    });
  }

  private sleepForRetry(
    response: Response,
    attempt: number,
  ): Effect.Effect<void, never> {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds = retryAfterHeader
      ? Number.parseInt(retryAfterHeader, 10)
      : NaN;
    const backoffMs = Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds * 1000
      : Math.pow(2, attempt) * 1000;
    const jitterMs = Math.floor(Math.random() * 250);
    return Effect.sleep(backoffMs + jitterMs);
  }

  private fetchContents(
    contentId: string,
    originalUrl: string,
    hashedPassword?: string,
  ): Effect.Effect<GofileApiResponse, GofilePasswordRequiredError | GofileScrapeError> {
    return Effect.gen(function* (this: GofileService) {
      let apiUrl = `${GOFILE_API}/contents/${contentId}?cache=true&sortField=createTime&sortDirection=1`;

      if (hashedPassword) {
        apiUrl += `&password=${hashedPassword}`;
      }

      const userAgent = getUserAgent();
      const maxRateLimitRetries = 6;
      const baseDelayMs = 1000;

      for (let attempt = 0; attempt <= maxRateLimitRetries; attempt++) {
        const websiteToken = yield* Effect.tryPromise({
          try: () => generateWebsiteToken(userAgent, this.authToken ?? ""),
          catch: (error) => new GofileScrapeError({ url: originalUrl, error }),
        });

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(apiUrl, {
              headers: {
                ...getSessionHeaders(this.authToken ?? undefined),
                "X-Website-Token": websiteToken,
                "X-BL": "en-US",
              },
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }),
          catch: (error) => new GofileScrapeError({ url: originalUrl, error }),
        });

        const parsedBody = yield* Effect.tryPromise({
          try: async () => {
            try {
              return (await response.json()) as GofileApiResponse;
            } catch {
              return null;
            }
          },
          catch: (error) => new GofileScrapeError({ url: originalUrl, error }),
        }).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (parsedBody?.status === "ok") {
          return parsedBody;
        }

        const isRateLimited =
          response.status === 429 ||
          parsedBody?.status === "error-rateLimit";

        if (isRateLimited && attempt < maxRateLimitRetries) {
          yield* this.sleepForRetry(response, attempt);
          continue;
        }

        return yield* Effect.fail(
          new GofileScrapeError({
            url: originalUrl,
            error: new Error(
              `Failed to fetch data from ${apiUrl} (status=${parsedBody?.status ?? response.status})`,
            ),
          }),
        );
      }

      return yield* Effect.fail(
        new GofileScrapeError({
          url: originalUrl,
          error: new Error(`No data received from ${apiUrl}`),
        }),
      );
    }.bind(this));
  }

  private buildContentTree(
    parentPath: string,
    contentId: string,
    rootContentId: string,
    originalUrl: string,
    files: GofileDownloadLink[],
    pathingCount: Map<string, number>,
    hashedPassword?: string,
    isRootContent = false,
  ): Effect.Effect<void, GofilePasswordRequiredError | GofileScrapeError> {
    return Effect.gen(function* (this: GofileService) {
      const data = yield* this.fetchContents(contentId, originalUrl, hashedPassword);

      if (
        data.data.password &&
        data.data.passwordStatus &&
        data.data.passwordStatus !== "passwordOk"
      ) {
        return yield* Effect.fail(new GofilePasswordRequiredError({ url: originalUrl }));
      }

      if (data.data.type !== "folder") {
        if (!data.data.link) {
          return yield* Effect.fail(
            new GofileScrapeError({
              url: originalUrl,
              error: new Error("File entry missing download link"),
            }),
          );
        }

        const name = resolveNamingCollision(
          pathingCount,
          parentPath,
          data.data.name || "unknown",
        );

        files.push({
          name: name.replace(/\\/g, "/"),
          url: data.data.link,
          headers: {
            ...this.getDownloadHeaders(),
            ...downloadRoutingHeaders(),
          },
        });
        return;
      }

      let folderPath = parentPath;

      if (!isRootContent) {
        const folderName = data.data.name || "folder";
        folderPath = resolveNamingCollision(
          pathingCount,
          parentPath,
          folderName,
          true,
        );
      }

      const children = data.data.children;
      if (!children) {
        return;
      }

      for (const child of Object.values(children)) {
        if (child.type === "folder") {
          yield* this.buildContentTree(
            folderPath,
            child.id,
            rootContentId,
            originalUrl,
            files,
            pathingCount,
            hashedPassword,
            false,
          );
        } else if (child.link) {
          const name = resolveNamingCollision(
            pathingCount,
            folderPath,
            child.name,
          );

          files.push({
            name: name.replace(/\\/g, "/"),
            url: child.link,
            headers: {
              ...this.getDownloadHeaders(),
              ...downloadRoutingHeaders(),
            },
          });
        }
      }
    }.bind(this));
  }
}
