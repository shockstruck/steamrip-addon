import { describe, it, expect } from "bun:test";
import { isFilecryptUrl } from "../lib/filecrypt";
import { detectServiceFromUrl } from "../lib/services/matcher";
import { getLinks } from "./scraper.test";
import GofileService from "../lib/services/Gofile";

const linksMap = await getLinks();

describe("FileCrypt URL Detection", () => {
  it("should detect valid filecrypt URLs", () => {
    const validUrls = [
      ...linksMap['filecrypt-test'].split(',')
    ];

    validUrls.forEach(url => {
      expect(isFilecryptUrl(url)).toBe(true);
    });
  });

  it("should reject non-filecrypt URLs", () => {
    const invalidUrls = [
      "https://google.com",
      "https://example.com",
      "https://filecrYpt.com", // Different spelling
      "https://filecrypt-fake.com",
      "https://notfilecrypt.cc",
      "invalid-url",
    ];

    invalidUrls.forEach(url => {
      expect(isFilecryptUrl(url)).toBe(false);
    });
  });

  it("should handle malformed URLs gracefully", () => {
    const malformedUrls = [
      "",
      "not-a-url",
      "://malformed",
      null,
      undefined,
    ];

    malformedUrls.forEach(url => {
      expect(isFilecryptUrl(url as string)).toBe(false);
    });
  });
});

describe("FileCrypt Service", () => {
  it("should detect FileCrypt service from URL", () => {
    const filecryptUrl = linksMap['filecrypt'];
    const service = detectServiceFromUrl(filecryptUrl);
    
    expect(service).not.toBeNull();
    expect(service?.name).toBe("FileCrypt");
  });

  it("should return the correct download links", async () => {
    const filecryptUrl = linksMap['filecrypt'];
    const service = detectServiceFromUrl(filecryptUrl);
    const downloadLinks = await service?.scrapeDownloadLinks(filecryptUrl);
    expect(downloadLinks).not.toBeNull();
    expect(downloadLinks?.length).toBeGreaterThan(0);
    expect(detectServiceFromUrl(downloadLinks?.[0].url as string)).toBeInstanceOf(GofileService);
  }, Number.MAX_SAFE_INTEGER);
});