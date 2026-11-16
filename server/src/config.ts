import { isIP } from 'node:net';
import { resolve } from 'node:path';
import type { ServerConfig } from './types.js';

export type { ServerConfig } from './types.js';

/** Parse once at startup; error messages never echo environment secrets. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ServerConfig {
  const mode = env.NODE_ENV === 'production' ? 'production' : 'development';
  const accessToken = (env.MUSE_ACCESS_TOKEN ?? '').trim();
  if (mode === 'production' && !accessToken) throw new Error('MUSE_ACCESS_TOKEN is required in production');
  if (/\s/.test(accessToken)) throw new Error('MUSE_ACCESS_TOKEN must not contain whitespace');

  const bind = (env.MUSE_BIND ?? '127.0.0.1').trim();
  if (!bind || (!isIP(bind) && !validHostname(bind))) throw new Error('Invalid MUSE_BIND');
  const rawPort = env.MUSE_PORT ?? '8787';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid MUSE_PORT');
  }

  let upstream: URL;
  try {
    upstream = new URL(env.MUSE_UPSTREAM_ORIGIN ?? 'https://muse.ai');
  } catch {
    throw new Error('Invalid MUSE_UPSTREAM_ORIGIN');
  }
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password ||
      upstream.search || upstream.hash || upstream.pathname !== '/') {
    throw new Error('Invalid MUSE_UPSTREAM_ORIGIN');
  }

  const rawDataDir = env.MUSE_DATA_DIR ?? './server-data';
  if (!rawDataDir.trim() || /[\x00-\x1f]/.test(rawDataDir)) throw new Error('Invalid MUSE_DATA_DIR');
  const dataDir = resolve(cwd, rawDataDir);
  if (dataDir === '/') throw new Error('Invalid MUSE_DATA_DIR');

  return { bind, port, accessToken, upstreamOrigin: upstream.origin, dataDir, mode };
}

function validHostname(value: string): boolean {
  return value.length <= 253 && value.split('.').every((label) =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}
