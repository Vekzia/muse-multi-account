import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses safe development defaults and resolves the data directory', () => {
    const config = loadConfig({}, '/tmp/muse-config-test');

    expect(config).toEqual({
      bind: '127.0.0.1',
      port: 8787,
      accessToken: '',
      upstreamOrigin: 'https://muse.ai',
      dataDir: '/tmp/muse-config-test/server-data',
      mode: 'development',
    });
  });

  it('requires a non-empty access token in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' }, '/tmp/muse')).toThrow(
      /MUSE_ACCESS_TOKEN/,
    );
    expect(loadConfig({ NODE_ENV: 'production', MUSE_ACCESS_TOKEN: '  secret  ' }, '/tmp/muse').accessToken).toBe('secret');
  });

  it.each([
    ['MUSE_BIND', { MUSE_BIND: '   ' }],
    ['MUSE_PORT', { MUSE_PORT: '0' }],
    ['MUSE_PORT', { MUSE_PORT: 'abc' }],
    ['MUSE_UPSTREAM_ORIGIN', { MUSE_UPSTREAM_ORIGIN: 'ftp://muse.ai' }],
    ['MUSE_UPSTREAM_ORIGIN', { MUSE_UPSTREAM_ORIGIN: 'https://muse.ai/path' }],
    ['MUSE_DATA_DIR', { MUSE_DATA_DIR: '   ' }],
  ])('rejects invalid %s values', (name, env) => {
    expect(() => loadConfig(env, '/tmp/muse')).toThrow(name);
  });

  it('accepts explicit bind, port, upstream, and data directory', () => {
    const config = loadConfig(
      {
        NODE_ENV: 'test',
        MUSE_BIND: '0.0.0.0',
        MUSE_PORT: '9001',
        MUSE_ACCESS_TOKEN: 'token',
        MUSE_UPSTREAM_ORIGIN: 'http://localhost:4000',
        MUSE_DATA_DIR: './var/muse',
      },
      '/opt/app',
    );

    expect(config).toEqual({
      bind: '0.0.0.0',
      port: 9001,
      accessToken: 'token',
      upstreamOrigin: 'http://localhost:4000',
      dataDir: '/opt/app/var/muse',
      mode: 'development',
    });
  });
});
