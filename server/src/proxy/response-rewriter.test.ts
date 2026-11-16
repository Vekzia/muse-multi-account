import { describe, expect, it } from 'vitest';
import {
  filterResponseHeaders,
  rewriteLocation,
  rewriteMuseText,
} from './response-rewriter.js';

describe('rewriteMuseText', () => {
  it('rewrites Muse origins while preserving paths, queries, fragments and relative URLs', () => {
    const source = [
      '<script src="https://muse.ai/assets/app.js?v=1"></script>',
      '<img src="https://www.muse.ai/static/logo.svg#mark">',
      '<a href="/account/settings">settings</a>',
      '<p>https://muse.ai is mentioned in visible copy</p>',
    ].join('');

    expect(rewriteMuseText(source, '/muse/7', 'https://muse.ai')).toBe([
      '<script src="/muse/7/assets/app.js?v=1"></script>',
      '<img src="/muse/7/static/logo.svg#mark">',
      '<a href="/muse/7/account/settings">settings</a>',
      '<p>https://muse.ai is mentioned in visible copy</p>',
    ].join(''));
  });

  it('rewrites a configured fixture origin in JSON and JavaScript text', () => {
    const source = '{"api":"http://127.0.0.1:43123/api/me","absolute":"https://muse.ai/x"}';
    expect(rewriteMuseText(source, '/muse/2', 'http://127.0.0.1:43123'))
      .toBe('{"api":"/muse/2/api/me","absolute":"/muse/2/x"}');
  });

  it('rewrites all configured origins into the account gateway prefix', () => {
    const source = '{"api":"https://api.muse.ai/patrique/images","prod":"https://production.museai.com/v1"}';
    expect(rewriteMuseText(source, '/muse/2', 'https://muse.ai', undefined, {
      api: 'https://api.muse.ai',
      production: 'https://production.museai.com',
    })).toBe('{"api":"/muse/2/__muse/origin/api/patrique/images","prod":"/muse/2/__muse/origin/production/v1"}');
    expect(rewriteLocation('https://api.muse.ai/login?next=%2F', '/muse/2/__muse/origin/api', 'https://api.muse.ai', undefined, {
      api: 'https://api.muse.ai',
    })).toBe('/muse/2/__muse/origin/api/login?next=%2F');
  });
});

describe('rewriteLocation', () => {
  it('supports root-mode and keeps external lookalike origins untouched', () => {
    expect(rewriteMuseText('<a href="https://muse.ai/a">a</a>', '', 'https://muse.ai'))
      .toBe('<a href="/a">a</a>');
    expect(rewriteMuseText('"https://muse.ai.evil.test/x"', '/muse/3', 'https://muse.ai'))
      .toBe('"https://muse.ai.evil.test/x"');
    expect(rewriteLocation('/api', '', 'https://muse.ai')).toBe('/api');
    expect(rewriteLocation('../login', '/muse/3', 'https://muse.ai')).toBe('../login');
  });
  it('maps absolute and root-relative upstream redirects to the account route', () => {
    expect(rewriteLocation('https://muse.ai/login?next=%2Fhome#top', '/muse/4', 'https://muse.ai'))
      .toBe('/muse/4/login?next=%2Fhome#top');
    expect(rewriteLocation('/api/session', '/muse/4', 'https://muse.ai'))
      .toBe('/muse/4/api/session');
    expect(rewriteLocation('https://muse.ai', '/muse/4', 'https://muse.ai'))
      .toBe('/muse/4/');
  });

  it('blocks redirects to an unrelated origin', () => {
    expect(rewriteLocation('https://evil.example/collect', '/muse/4', 'https://muse.ai')).toBeUndefined();
  });
});

describe('filterResponseHeaders', () => {
  it('removes hop-by-hop, browser cookie, framing and CSP headers', () => {
    const filtered = filterResponseHeaders({
      connection: 'keep-alive, x-private',
      'x-private': 'secret',
      'transfer-encoding': 'chunked',
      'set-cookie': ['sid=private'],
      'content-security-policy': "default-src 'none'",
      'x-frame-options': 'DENY',
      location: 'https://muse.ai/next',
      'content-type': 'text/html; charset=utf-8',
    }, '/muse/1', 'https://muse.ai');

    expect(filtered).toEqual({
      location: '/muse/1/next',
      'content-type': 'text/html; charset=utf-8',
    });
  });
});
