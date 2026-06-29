import { DLService } from "./BaseService";
import { Effect, pipe } from "effect";
import { GofilePasswordRequiredError, GofileScrapeError } from "../errors";
import type { EventResponse, SearchResult } from "ogi-addon";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GofileApiResponse {
  status: string;
  data: {
    token?: string;
    id?: string;
    type?: "file" | "folder" | string;
    name?: string;
    link?: string;
    children?: Record<string, GofileContent>;
    // present when the content is password protected
    password?: string;
    passwordStatus?: string;
  };
}

interface GofileContent {
  id: string;
  type: "file" | "folder" | string;
  name: string;
  link?: string;
}

export type GofileDownloadLink = {
  name: string;
  url: string;
  headers: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Constants (matching the upstream ltsdw/gofile-downloader Python script)
// ---------------------------------------------------------------------------

const GOFILE_ORIGIN = "https://gofile.io";
const GOFILE_API = "https://api.gofile.io";

/**
 * Salt used in the dynamic `X-Website-Token` SHA-256 hash.
 * MUST match the Python's `generate_website_token` exactly:
 *   sha256("{user_agent}::en-US::{account_token}::{time_slot}::9844d94d963d30")
 * where `time_slot = floor(unix_time / 14400)`.
 */
const WEBSITE_TOKEN_SALT = "9844d94d963d30";
const DEFAULT_USER_AGENT = "Mozilla/5.0";

/** Default folder name that the GoFile API auto-creates; we skip it. */
const DEFAULT_ROOT_FOLDER_NAME = "root";

/** Upper bound enforced by the upstream script: never exceed 10 workers. */
const MAX_CONCURRENT_DOWNLOADS_CAP = 10;

// ---------------------------------------------------------------------------
// Env-var configuration (all `GF_*`, matching the upstream script)
// ---------------------------------------------------------------------------

const MAX_RETRIES = parseIntEnv("GF_MAX_RETRIES", 5);
const REQUEST_TIMEOUT_S = parseFloatEnv("GF_TIMEOUT", 5);
const REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_S * 1000;
const CHUNK_SIZE = parseIntEnv("GF_CHUNK_SIZE", 2097152); // 2 MiB
const MAX_CONCURRENT_DOWNLOADS = Math.min(
  parseIntEnv("GF_MAX_CONCURRENT_DOWNLOADS", 5),
  MAX_CONCURRENT_DOWNLOADS_CAP,
);
// GF_DOWNLOAD_DIR is forwarded to the downstream OGI host via the
// X-OGI-Download-Dir header so it can write the files in the right place.
const DOWNLOAD_DIR = process.env.GF_DOWNLOAD_DIR ?? "";

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getUserAgent(): string {
  return process.env.GF_USERAGENT ?? DEFAULT_USER_AGENT;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generates the dynamic `X-Website-Token` required by the GoFile API.
 *
 * Mirrors the upstream `generate_website_token`:
 *   sha256(f"{user_agent}::en-US::{account_token}::{time_slot}::9844d94d963d30")
 *   where time_slot = floor(unix_time / 14400)  (a 4-hour window)
 *
 * Exposed for testing — the service uses the same formula internally.
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
 *   - strip characters illegal on Windows (`<>:"/\\|?*`)
 *   - strip leading/trailing whitespace and dots
 *   - collapse the segment to a non-empty fallback when nothing remains
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

/**
 * Returns a unique path under `parentPath` for `childName`, appending
 * ` (N)` (or ` (N)` before the extension for files) on collision. This
 * matches the upstream `_resolve_naming_collision` helper.
 */
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
    // no extension (or hidden file with no stem) — append at the end
    return `${filepath}(${count})`;
  }

  return `${safeParent}/${sanitizedChild.slice(0, dotIndex)}(${count})${sanitizedChild.slice(dotIndex)}`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

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
    return Effect.gen(function*(this: GofileService) {
      // test if even able to connect to gofile's servers
      yield* pipe(
        this.fetchWithRetries(`${GOFILE_API}`, { method: "GET" }),
        Effect.catchAll(() => Effect.fail(new GofileScrapeError({ url: GOFILE_API, error: new Error("Failed to connect to GoFile API, user seems blocked.") }))),
      );

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
        url,
        files,
        pathingCount,
        hashedPassword,
        true,
      );

      return files;
    }.bind(this));
  }

  // -------------------------------------------------------------------------
  // URL parsing — must contain `/d/` per the upstream contract
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private getDownloadHeaders(): Record<string, string> {
    return this.authToken ? getSessionHeaders(this.authToken) : {};
  }

  /**
   * Mirrors the upstream `Manager._set_account_access_token`. If a token is
   * supplied (via the `GF_TOKEN` env var) we use it directly; otherwise we
   * `POST /accounts` to mint a fresh one.
   */
  private setAccountAccessToken(
    token?: string,
  ): Effect.Effect<void, GofileScrapeError> {
    return Effect.gen(function*(this: GofileService) {
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

  // -------------------------------------------------------------------------
  // Network primitives
  // -------------------------------------------------------------------------

  private fetchWithRetries(
    url: string,
    init: RequestInit,
  ): Effect.Effect<Response | null, never> {
    return Effect.gen(function*() {
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

  // -------------------------------------------------------------------------
  // Content tree fetching + walking
  // -------------------------------------------------------------------------

  private fetchContents(
    contentId: string,
    originalUrl: string,
    hashedPassword?: string,
  ): Effect.Effect<GofileApiResponse, GofilePasswordRequiredError | GofileScrapeError> {
    return Effect.gen(function*(this: GofileService) {
      let apiUrl = `${GOFILE_API}/contents/${contentId}?cache=true&sortField=createTime&sortDirection=1`;

      if (hashedPassword) {
        apiUrl += `&password=${hashedPassword}`;
      }

      const userAgent = getUserAgent();
      const maxRateLimitRetries = 6;

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

  /**
   * Recursively walks the content tree starting at `contentId`, registering
   * every leaf file into `files`. Mirrors the upstream
   * `_build_content_tree_structure`.
   */
  private buildContentTree(
    parentPath: string,
    contentId: string,
    originalUrl: string,
    files: GofileDownloadLink[],
    pathingCount: Map<string, number>,
    hashedPassword?: string,
    isRootContent = false,
  ): Effect.Effect<void, GofilePasswordRequiredError | GofileScrapeError> {
    return Effect.gen(function*(this: GofileService) {
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

        files.push(this.buildDownloadLink(name, data.data.link));
        return;
      }

      let folderPath = parentPath;

      if (!isRootContent) {
        const folderName = data.data.name || "folder";

        // Skip the default "root" folder that GoFile auto-creates — its
        // children belong directly under the parent path, matching the
        // upstream script's behaviour.
        if (folderName !== DEFAULT_ROOT_FOLDER_NAME) {
          folderPath = resolveNamingCollision(
            pathingCount,
            parentPath,
            folderName,
            true,
          );
        }
      } else if (
        data.data.name &&
        data.data.name !== DEFAULT_ROOT_FOLDER_NAME
      ) {
        // For the top-level content, mirror the upstream: if the parent dir
        // already matches the content_id, reuse it. Otherwise create a
        // folder named after the content (sanitised).
        folderPath = resolveNamingCollision(
          pathingCount,
          parentPath,
          data.data.name,
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

          files.push(this.buildDownloadLink(name, child.link));
        }
      }
    }.bind(this));
  }

  /**
   * Constructs a `GofileDownloadLink` with the right headers for the
   * downstream host. The host is expected to honour:
   *   - `Cookie` / `Authorization` for GoFile authentication
   *   - `OGI-Parallel-Limit` to throttle concurrent file downloads
   *   - `Accept-Ranges: bytes` to enable resume on partial transfers
   *   - `User-Agent` if the host overrides it
   *   - `OGI-Chunk-Size` to pick a chunk size for resumable transfers
   *   - `X-OGI-Download-Dir` (only if `GF_DOWNLOAD_DIR` is set) to choose
   *     the on-disk location
   */
  private buildDownloadLink(name: string, link: string): GofileDownloadLink {
    const headers = this.getDownloadHeaders();
    const downloadHeaders: Record<string, string> = {
      ...headers,
      "User-Agent": getUserAgent(),
      "Accept-Ranges": "bytes",
      // Caps parallel workers per the upstream `GF_MAX_CONCURRENT_DOWNLOADS`
      "OGI-Parallel-Limit": String(MAX_CONCURRENT_DOWNLOADS),
      // Chunk size for the resume / partial-download logic
      "OGI-Chunk-Size": String(CHUNK_SIZE),
    };
    if (DOWNLOAD_DIR) {
      downloadHeaders["X-OGI-Download-Dir"] = DOWNLOAD_DIR;
    }
    return {
      name,
      url: link,
      headers: downloadHeaders,
    };
  }
}
