import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer, type Server } from 'node:http';
import { createServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let upstream: Server;
let dataDir: string;
const token = 'playwright-secret-123456789012';
const base = 'http://127.0.0.1:25079';

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'muse-e2e-'));
  upstream = httpServer((req, res) => {
    if (req.url === '/login' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'hatch_sess=fixture-session; Path=/; HttpOnly');
      res.end('ok'); return;
    }
    if (req.url === '/session') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ logged: Boolean(req.headers.cookie?.includes('hatch_sess=')) })); return;
    }
    if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end('body{font:18px sans-serif;background:#eef2ff;color:#182134;padding:24px}button{padding:12px}'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><h1>Muse Fixture</h1><p id="login-state">Checking</p><button id="login">Sign in fixture</button><input id="storage-input" placeholder="Private account value"><button id="store">Save value</button><p id="stored"></p><script>
      const status=()=>fetch('/session').then(r=>r.json()).then(v=>document.querySelector('#login-state').textContent=v.logged?'Signed in':'Signed out');
      document.querySelector('#login').onclick=()=>fetch('/login',{method:'POST'}).then(status);
      document.querySelector('#store').onclick=()=>{localStorage.setItem('account-fixture',document.querySelector('#storage-input').value);document.querySelector('#stored').textContent=localStorage.getItem('account-fixture')};
      document.querySelector('#stored').textContent=localStorage.getItem('account-fixture')||'';status();
    </script></body></html>`);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  app = await createServer({ config: { bind: '127.0.0.1', port: 25079, accessToken: token, upstreamOrigin: `http://127.0.0.1:${(upstream.address() as {port:number}).port}`, dataDir, mode: 'development' }, logger: false, gatewayPort: 25080, publicHost: '127.0.0.1', gatewayCount: 8 });
  await app.listen({ host: '127.0.0.1', port: 25079 });
});
test.afterAll(async () => {
  await app?.close();
  if (upstream) await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});
async function connect(page: Page) {
  await page.goto(base);
  await page.locator('#token-input').fill(token);
  await page.getByRole('button', { name: '连接工作台' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
}
async function createAccount(page: Page, name: string, first = false) {
  page.once('dialog', dialog => dialog.accept(name));
  if (!first && await page.locator('#drawer-toggle').isVisible()) await page.locator('#drawer-toggle').click();
  await page.locator(first ? '#empty-create-button' : '#new-account-button').click();
  await expect(page.locator('#account-title')).toHaveText(name);
  if (await page.locator('#drawer-toggle').isVisible() && await page.locator('#account-drawer').evaluate(el => el.classList.contains('is-open'))) await page.locator('#drawer-toggle').click();
}

test('switches real proxied frames with separate cookies and browser storage', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await connect(page);
  await expect(page.getByText('还没有账号')).toBeVisible();
  await createAccount(page, '工作账号', true);
  await page.locator('#launch-button').click();
  let frame = page.frameLocator('#muse-frame');
  await expect(frame.getByRole('heading', { name: 'Muse Fixture' })).toBeVisible();
  await expect(frame.locator('#login-state')).toHaveText('Signed out');
  await frame.locator('#login').click();
  await expect(frame.locator('#login-state')).toHaveText('Signed in');
  await frame.locator('#storage-input').fill('account-A-only');
  await frame.locator('#store').click();
  await createAccount(page, '备用账号');
  await page.locator('#launch-button').click();
  frame = page.frameLocator('#muse-frame');
  await expect(frame.locator('#login-state')).toHaveText('Signed out');
  await expect(frame.locator('#stored')).toHaveText('');
  if (await page.locator('#drawer-toggle').isVisible()) await page.locator('#drawer-toggle').click();
  await page.locator('[data-account-id="1"]').click();
  await expect(frame.locator('#login-state')).toHaveText('Signed in');
  await expect(frame.locator('#stored')).toHaveText('account-A-only');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true });
});

test('rejects wrong token without exposing account API', async ({ page }) => {
  await page.goto(base);
  await page.locator('#token-input').fill('wrong');
  await page.getByRole('button', { name: '连接工作台' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#token-error')).toContainText('令牌');
});
