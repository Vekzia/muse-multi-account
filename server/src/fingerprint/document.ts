import type { Fingerprint } from '../types.js';
import { injectFingerprint } from './script.js';
import { advancedFingerprintScript, type AdvancedFingerprintOptions } from './advanced.js';

/** Keep every document shim before upstream code, with core installed before advanced policies. */
export function injectAccountFingerprint(html: string, fp: Fingerprint, options?: AdvancedFingerprintOptions): string {
  const core = injectFingerprint(html, fp);
  const advanced = advancedFingerprintScript(fp, options);
  if (!advanced) return core;
  // Match the core injector's leading-container scan. A global marker search
  // also matches comments/attributes and can silently insert policies into them.
  let start = /^(?:\uFEFF|\s|<!--[^]*?-->|<!doctype\b[^>]*>)*/i.exec(core)![0].length;
  for (const name of ['html', 'head']) {
    const match = /^<(html|head)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/i.exec(core.slice(start));
    if (match?.[1]?.toLowerCase() === name) {
      start += match[0].length;
      start += /^(?:\s|<!--[^]*?-->)*\s*/.exec(core.slice(start))![0].length;
    }
  }
  if (!core.startsWith('<script data-muse-fingerprint>', start)) return core;
  const end = core.indexOf('</script>', start) + '</script>'.length;
  return core.slice(0, end) + '<script data-muse-advanced>' + advanced + '</script>' + core.slice(end);
}
