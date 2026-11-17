import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { Fingerprint } from '../types.js';
import { injectAccountFingerprint } from './document.js';

const fp = { enabled: true, seed: 42, uaMode: 'system', uaCustom: '', locale: '', timezone: '', webdriver: false, noise: false, webrtc: false, webgpuMode: 'disabled' } as Fingerprint;
describe('account fingerprint insertion', () => {
  it('installs advanced policies outside misleading leading comments before source executes', () => {
    const comment = '<!-- <script data-muse-fingerprint>fake()</script> -->';
    const html = '<!doctype html>' + comment + '<html data-label=">\"><head><script>globalThis.seen=typeof navigator.gpu</script></head></html>';
    const output = injectAccountFingerprint(html, fp);
    const context = createContext({ URL, location: new URL('http://localhost:4100/'), navigator: { gpu: {} }, screen: {} });
    for (const match of output.replace(/<!--[^]*?-->/g, '').matchAll(/<script[^>]*>([^]*?)<\/script>/g)) runInContext(match[1]!, context);
    expect(context.seen).toBe('undefined');
    expect(output).toContain(comment);
  });

  it('leaves disabled documents unchanged', () => {
    const html = '<!doctype html><!-- <script data-muse-fingerprint>x</script> --><p>native</p>';
    expect(injectAccountFingerprint(html, { ...fp, enabled: false })).toBe(html);
  });
});
