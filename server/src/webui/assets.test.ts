import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerWebUi } from './assets.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('management WebUI assets', () => {
  it('serves the login shell and only known same-origin assets', async () => {
    const app = Fastify();
    apps.push(app);
    registerWebUi(app);
    const page = await app.inject('/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.body).toContain('type="password"');
    expect(page.body).toContain('aria-live="polite"');
    expect(page.body).toContain('id="account-list"');
    for (const path of ['/app.js', '/styles.css']) {
      const response = await app.inject(path);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toContain('no-cache');
    }
    expect((await app.inject('/package.json')).statusCode).toBe(404);
    expect((await app.inject('/src/server.ts')).statusCode).toBe(404);
  });
});
