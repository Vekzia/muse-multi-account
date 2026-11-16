import { describe, expect, it } from 'vitest';
import { parseProxy, redactProxy } from './proxy-url.js';

describe('parseProxy', () => {
  it.each([
    ['http://proxy.example:8080', 'http:', 'proxy.example', 8080],
    ['https://proxy.example', 'https:', 'proxy.example', 443],
    ['http://localhost', 'http:', 'localhost', 80],
    ['socks5://127.0.0.1', 'socks5:', '127.0.0.1', 1080],
    ['socks5://[::1]:1081', 'socks5:', '::1', 1081],
  ])('parses %s with connector-ready fields', (raw, protocol, hostname, port) => {
    expect(parseProxy(raw)).toMatchObject({ protocol, hostname, port });
  });

  it('normalizes surrounding whitespace and decodes supported proxy credentials once', () => {
    const parsed = parseProxy('  HTTP://alice%40example:p%3Ass%25word@PROXY.example:8080/  ');
    expect(parsed).toMatchObject({
      url: 'http://alice%40example:p%3Ass%25word@proxy.example:8080/',
      username: 'alice@example',
      password: 'p:ss%word',
    });
  });

  it.each([
    '', 'proxy.example:8080', 'ftp://proxy.example:21', 'socks4://proxy.example:1080',
    'http:///proxy.example', 'http://', 'http://bad_host:8080',
    'http://proxy.example:0', 'http://proxy.example:65536', 'http://proxy.example:nope',
    'http://proxy.example:', 'http://proxy.example/path', 'http://proxy.example?token=secret',
    'http://proxy.example#secret', 'http://proxy.example?', 'http://proxy.example#',
    'http://user:bad%escape@proxy.example', 'http://user:bad%0Apassword@proxy.example',
    'http://proxy.\nexample:8080', 'http://proxy.example\\other',
  ])('rejects malformed proxy without reflecting input: %s', (raw) => {
    expect(() => parseProxy(raw)).toThrowError(/^Invalid proxy URL$/);
  });

  it('never attaches raw credentials to validation errors', () => {
    try {
      parseProxy('ftp://PRIVATE_USER:PRIVATE_PASSWORD@proxy.example:21');
      expect.fail('Expected invalid proxy to fail');
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE_');
      expect(JSON.stringify(error)).not.toContain('PRIVATE_');
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('redactProxy', () => {
  it('redacts both username and password from strings and parsed proxies', () => {
    const raw = 'socks5://PRIVATE_USER:PRIVATE_PASSWORD@proxy.example:1080';
    expect(redactProxy(raw)).toBe('socks5://***:***@proxy.example:1080');
    expect(redactProxy(parseProxy(raw))).toBe('socks5://***:***@proxy.example:1080');
  });

  it('keeps credential-free addresses useful for diagnostics', () => {
    expect(redactProxy('http://[::1]:8080')).toBe('http://[::1]:8080');
  });

  it('does not echo malformed proxy input', () => {
    expect(redactProxy('bad PRIVATE_USER:PRIVATE_PASSWORD')).toBe('[invalid proxy]');
  });
});
