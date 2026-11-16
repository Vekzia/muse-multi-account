export const ORIGIN_PREFIX = '/__muse/origin/';
export type AdditionalOrigins = Record<string, string>;

export function validateOrigins(origins: AdditionalOrigins): void {
  for (const [alias, raw] of Object.entries(origins)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(alias)) throw new Error('Invalid upstream alias');
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid upstream origin');
  }
}

/** Aliases come from startup configuration only, never from request-supplied hosts. */
export function resolveUpstreamOrigin(path: string, primary: string, origins: AdditionalOrigins = {}): { origin: string; path: string; prefix: string } | undefined {
  if (!path.startsWith(ORIGIN_PREFIX)) return { origin: primary, path, prefix: '' };
  const match = /^\/__muse\/origin\/([a-z][a-z0-9_-]{0,63})(\/[^#]*)?(\?[^#]*)?$/.exec(path);
  if (!match || !Object.hasOwn(origins, match[1]!)) return undefined;
  const targetPath = (match[2] || '/') + (match[3] || '');
  if (targetPath.startsWith('//') || targetPath.includes('\\')) return undefined;
  return { origin: origins[match[1]!]!, path: targetPath, prefix: ORIGIN_PREFIX + match[1]! };
}

export function baseForOrigin(origin: string, base: string, primary: string, origins: AdditionalOrigins): string | undefined {
  const actual = new URL(origin).origin;
  if (actual === new URL(primary).origin) return base;
  // The canonical www redirect stays on the primary gateway.
  if (new URL(primary).hostname === 'muse.ai' && actual === 'https://www.muse.ai') return base;
  for (const [alias, value] of Object.entries(origins)) if (new URL(value).origin === actual) return base + ORIGIN_PREFIX + alias;
  return undefined;
}
