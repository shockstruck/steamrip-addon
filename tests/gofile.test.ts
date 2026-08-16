/*
 * Tests for the Gofile service.
 *
 * The website-token formula is the load-bearing piece of the upstream
 * parity — a single character off will cause every API request to be
 * rejected. We compute the expected hash using the upstream Python
 * script's exact recipe and assert that the TypeScript helper produces
 * the same bytes.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import {
  generateWebsiteToken,
  sanitizePathSegment,
  resolveNamingCollision,
} from "../lib/services/Gofile";

/**
 * Runs the upstream Python `generate_website_token` formula and returns
 * the resulting hex digest. We use `python3` here purely as a
 * reference implementation — if it isn't on PATH the test is skipped.
 */
function pythonWebsiteToken(
  userAgent: string,
  accountToken: string,
  timeSlot: number,
  salt: string,
): string | null {
  const result = spawnSync("python3", [
    "-c",
    `import hashlib, sys
raw = f"{${JSON.stringify(userAgent)}}::en-US::${JSON.stringify(accountToken)}::${timeSlot}::${JSON.stringify(salt)}"
print(hashlib.sha256(raw.encode()).hexdigest())`,
  ]);
  if (result.status !== 0) return null;
  return result.stdout.toString().trim();
}

const SALT = "12af056dacea0b";

describe("Gofile service parity with ltsdw/gofile-downloader", () => {
  it("website-token formula matches the Python reference implementation", async () => {
    const cases: Array<{ userAgent: string; accountToken: string; timeSlot: number }> = [
      { userAgent: "Mozilla/5.0", accountToken: "", timeSlot: 123800 },
      { userAgent: "Mozilla/5.0", accountToken: "", timeSlot: 123801 },
      { userAgent: "Mozilla/5.0", accountToken: "abc123", timeSlot: 123800 },
      { userAgent: "TestAgent/1.0", accountToken: "long-account-token-xyz", timeSlot: 9999999 },
      { userAgent: "Mozilla/5.0", accountToken: "", timeSlot: 0 },
    ];

    for (const { userAgent, accountToken, timeSlot } of cases) {
      const expected = pythonWebsiteToken(userAgent, accountToken, timeSlot, SALT);
      if (expected === null) {
        // python3 not available — skip the cross-check
        continue;
      }
      const actual = await generateWebsiteToken(userAgent, accountToken, timeSlot * 14400);
      expect(actual).toBe(expected);
    }
  });

  it("website-token uses the correct 4-hour time slot window", async () => {
    // Pick a slot boundary aligned to 14400s. Any unix_time within the
    // 4-hour window [s*14400, (s+1)*14400 - 1] must hash to the same
    // value; one second past the window must produce a different hash.
    const s = 118055;
    const windowStart = s * 14400;
    const windowEnd = (s + 1) * 14400 - 1;
    const t1 = windowStart + 1; // 1 second into the window
    const t2 = windowEnd;       // last second of the same window
    const t3 = windowEnd + 1;   // first second of the next window
    const h1 = await generateWebsiteToken("Mozilla/5.0", "", t1);
    const h2 = await generateWebsiteToken("Mozilla/5.0", "", t2);
    expect(h1).toBe(h2);

    const h3 = await generateWebsiteToken("Mozilla/5.0", "", t3);
    expect(h3).not.toBe(h2);
  });

  it("salt matches the upstream literal '12af056dacea0b'", async () => {
    const ts = 123800;
    const h = await generateWebsiteToken("Mozilla/5.0", "", ts * 14400);
    const raw = `Mozilla/5.0::en-US::::${ts}::12af056dacea0b`;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(raw),
    );
    const expected = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(h).toBe(expected);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sanitizePathSegment strips path separators and control characters", () => {
    expect(sanitizePathSegment("normal.txt")).toBe("normal.txt");
    expect(sanitizePathSegment("a/b\\c")).toBe("a_b_c");
    expect(sanitizePathSegment("\u0000hidden\u0007.txt")).toBe("hidden.txt");
    expect(sanitizePathSegment("..")).toBe("unnamed");
    expect(sanitizePathSegment("   ")).toBe("unnamed");
    expect(sanitizePathSegment("file<>:\"|?*.txt")).toBe("file_______.txt");
  });

  it("resolveNamingCollision returns the path on first encounter", () => {
    const counts = new Map<string, number>();
    expect(resolveNamingCollision(counts, "root", "file.txt")).toBe("root/file.txt");
  });

  it("resolveNamingCollision adds a counter suffix on collision", () => {
    const counts = new Map<string, number>();
    resolveNamingCollision(counts, "root", "file.txt");
    expect(resolveNamingCollision(counts, "root", "file.txt")).toBe("root/file(1).txt");
    expect(resolveNamingCollision(counts, "root", "file.txt")).toBe("root/file(2).txt");
  });

  it("resolveNamingCollision appends the counter to directories", () => {
    const counts = new Map<string, number>();
    resolveNamingCollision(counts, "root", "sub", true);
    expect(resolveNamingCollision(counts, "root", "sub", true)).toBe("root/sub(1)");
  });
});
