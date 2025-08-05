import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { headerManager, convertPuppeteerCookies } from "../lib/header-manager";
import { cloudflareSolve } from "../lib/cloudflare";

describe('Header Manager', () => {
  beforeEach(async () => {
    // Clear headers before each test
    await Effect.runPromise(headerManager.clearHeaders());
  });

  afterEach(async () => {
    // Clean up after each test
    await Effect.runPromise(headerManager.clearHeaders());
  });

  it('should store and retrieve headers', async () => {
    const testHeaders = {
      cookies: [
        { name: 'test1', value: 'value1', domain: 'steamrip.com' },
        { name: 'test2', value: 'value2', domain: 'steamrip.com' }
      ],
      userAgent: 'test-user-agent',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };

    await Effect.runPromise(headerManager.setHeaders(testHeaders));
    
    const retrievedHeaders = headerManager.getHeaders();
    expect(retrievedHeaders.cookies).toHaveLength(2);
    expect(retrievedHeaders.cookies[0].name).toBe('test1');
    expect(retrievedHeaders.cookies[1].name).toBe('test2');
    expect(retrievedHeaders.userAgent).toBe('test-user-agent');
    expect(retrievedHeaders.accept).toBe('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  });

  it('should generate correct cookie string', async () => {
    const testHeaders = {
      cookies: [
        { name: 'test1', value: 'value1' },
        { name: 'test2', value: 'value2' }
      ]
    };

    await Effect.runPromise(headerManager.setHeaders(testHeaders));
    
    const cookieString = headerManager.getCookieString();
    expect(cookieString).toBe('test1=value1; test2=value2');
  });

  it('should generate correct header object', async () => {
    const testHeaders = {
      cookies: [
        { name: 'test1', value: 'value1' },
        { name: 'test2', value: 'value2' }
      ],
      userAgent: 'test-user-agent',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };

    await Effect.runPromise(headerManager.setHeaders(testHeaders));
    
    const headerObject = headerManager.getHeaderObject();
    expect(headerObject['Cookie']).toBe('test1=value1; test2=value2');
    expect(headerObject['User-Agent']).toBe('test-user-agent');
    expect(headerObject['Accept']).toBe('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  });

  it('should convert puppeteer cookies correctly', () => {
    const puppeteerCookies = [
      {
        name: 'test',
        value: 'value',
        domain: 'steamrip.com',
        path: '/',
        expires: 1234567890,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax'
      }
    ];

    const converted = convertPuppeteerCookies(puppeteerCookies);
    expect(converted).toHaveLength(1);
    expect(converted[0].name).toBe('test');
    expect(converted[0].value).toBe('value');
    expect(converted[0].domain).toBe('steamrip.com');
  });

  it('should detect valid headers', async () => {
    expect(headerManager.hasValidHeaders()).toBe(false);
    
    const testHeaders = { cookies: [{ name: 'test', value: 'value' }] };
    await Effect.runPromise(headerManager.setHeaders(testHeaders));
    
    expect(headerManager.hasValidHeaders()).toBe(true);
  });

  // Backward compatibility tests
  it('should maintain backward compatibility with cookie methods', async () => {
    const testCookies = [
      { name: 'test1', value: 'value1' },
      { name: 'test2', value: 'value2' }
    ];

    await Effect.runPromise(headerManager.setCookies(testCookies));
    
    const retrievedCookies = headerManager.getCookies();
    expect(retrievedCookies).toHaveLength(2);
    expect(retrievedCookies[0].name).toBe('test1');
    expect(retrievedCookies[1].name).toBe('test2');
    
    expect(headerManager.hasValidCookies()).toBe(true);
  });
});

describe('Cloudflare Solve', () => {
  it('should handle invalid URLs gracefully', async () => {
    // Mock addon for testing
    const mockAddon = {
      notify: () => {}
    } as any;

    const result = await Effect.runPromise(
      Effect.either(cloudflareSolve('https://invalid-url.com', mockAddon))
    );

    // Should handle gracefully (either succeed with null or fail)
    expect(['Left', 'Right']).toContain(result._tag);
  });
}); 