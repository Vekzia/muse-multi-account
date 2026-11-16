import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer, type Server } from 'node:http';
import { createServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance, upstream: Server, dataDir: string;
const token='fingerprint-browser-fixture'; const base='http://127.0.0.1:25377';
// Test deliberately stops/rebinds the server. Do not reuse a pooled socket from before restart.
const headers={authorization:`Bearer ${token}`,'Content-Type':'application/json',connection:'close'};
let firstId:number, secondId:number;
const config=()=>({bind:'127.0.0.1',port:25377,accessToken:token,upstreamOrigin:`http://127.0.0.1:${(upstream.address() as {port:number}).port}`,dataDir,mode:'development' as const});
async function boot(){ app=await createServer({config:config(),gatewayPort:25378,gatewayCount:4,logger:false});await app.listen({host:'127.0.0.1',port:25377}); }
async function api(path:string,method='GET',body?:unknown){const r=await fetch(base+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});expect(r.ok).toBe(true);return r.status===204?null:await r.json() as any;}
async function openCheck(page:Page,id:number){
 const launch=await api('/api/session','POST',{accountId:id,target:'fingerprint'});
 await page.goto(base);
 await page.evaluate(({url,token})=>{const f=document.createElement('form');f.method='POST';f.action=url;const i=document.createElement('input');i.type='hidden';i.name='token';i.value=token;f.append(i);document.body.append(f);f.submit();},launch);
 await page.waitForURL(/__muse\/fingerprint$/);
 await page.waitForFunction(()=>!!(window as any).__museFingerprintObserved);
 return page.evaluate(()=>(window as any).__museFingerprintObserved);
}
test.beforeAll(async()=>{
 dataDir=await mkdtemp(join(tmpdir(),'muse-fp-browser-'));
 upstream=httpServer((req,res)=>{if(req.url==='/headers'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.headers));return;}
 res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><script>window.firstUA=navigator.userAgent</script></head><body>Muse fixture</body></html>');});
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));await boot();
 firstId=(await api('/api/accounts','POST',{name:'固定指纹 A'})).account.id;
 secondId=(await api('/api/accounts','POST',{name:'固定指纹 B'})).account.id;
});
test.afterAll(async()=>{await app?.close();if(upstream)await new Promise<void>(r=>{upstream.close(()=>r());upstream.closeAllConnections();});if(dataDir)await rm(dataDir,{recursive:true,force:true});});

test('two persisted account profiles remain distinct across reload, restart, and backup restore',async({page})=>{
 const a=(await api(`/api/accounts/${firstId}/fingerprint/generate`,'POST',{mode:'windows'})).account;
 const b=(await api(`/api/accounts/${secondId}/fingerprint/generate`,'POST',{mode:'android'})).account;
 expect(a.fp.seed).not.toBe(b.fp.seed);
 await api(`/api/accounts/${firstId}`,'PATCH',{fp:{timezone:'America/New_York',locale:'fr-FR',noise:true}});
 const observedA=await openCheck(page,firstId);
 expect(observedA.userAgent).toContain('Windows NT');expect(observedA.platform).toBe('Win32');expect(observedA.timezone).toBe('America/New_York');expect(observedA.language).toBe('fr-FR');
 expect(observedA.januaryOffset).toBe(300);expect(observedA.julyOffset).toBe(240);expect(observedA.canvas.stableRead).toBe(true);expect(observedA.canvas.stableExport).toBe(true);
 const echoed=await page.evaluate(async()=>await(await fetch('/headers')).json());expect(echoed['user-agent']).toBe(observedA.userAgent);expect(echoed['accept-language']).toContain('fr-FR');
 await page.reload();await page.waitForFunction(()=>!!(window as any).__museFingerprintObserved);
 expect(await page.evaluate(()=>(window as any).__museFingerprintObserved.canvas.readHash)).toBe(observedA.canvas.readHash);
 const observedB=await openCheck(page,secondId);expect(observedB.userAgent).toContain('Android 14');expect(observedB.canvas.readHash).not.toBe(observedA.canvas.readHash);
 const backup=await api('/api/backup/export');
 await app.close();await boot();
 expect((await api(`/api/accounts/${firstId}`)).account.fp.seed).toBe(a.fp.seed);
 expect((await openCheck(page,firstId)).canvas.readHash).toBe(observedA.canvas.readHash);
 const regenerated=(await api(`/api/accounts/${firstId}/fingerprint/generate`,'POST',{mode:'macos'})).account;expect(regenerated.fp.seed).not.toBe(a.fp.seed);
 await api('/api/backup/import?mode=replace','POST',backup);
 const restored=await openCheck(page,firstId);expect(restored.canvas.readHash).toBe(observedA.canvas.readHash);
 expect((await api(`/api/accounts/${firstId}`)).account.fp.seed).toBe(a.fp.seed);
});

test('WebUI saves and resets fingerprint and opens account-origin selfcheck',async({page},info)=>{
 await page.goto(base);await page.locator('#token-input').fill(token);await page.locator('#token-submit').click();
 await expect(page.locator('#fp-title')).toBeVisible();
 await page.locator('#fp-enabled').check();
 await page.locator('#fp-mode').selectOption('custom');
 await page.locator('#fp-custom').fill('MuseCustom/1.6');
 await page.locator('#fp-locale').fill('en-GB');await page.locator('#fp-timezone').fill('Asia/Tokyo');
 page.on('dialog',dialog=>dialog.accept());
 await page.locator('#fp-save').click();await expect(page.locator('#fp-status')).toContainText('已保存');
 await page.locator('#fp-check').click();const frame=page.frameLocator('#muse-frame');
 await expect(frame.getByRole('heading',{name:'账号指纹自检'})).toBeVisible();
 await expect(frame.locator('#observed')).toContainText('MuseCustom/1.6');
 await page.locator('#fp-title').scrollIntoViewIfNeeded();
 await page.screenshot({path:info.outputPath('fingerprint-settings.png'),fullPage:true});
 await page.locator('#muse-frame').scrollIntoViewIfNeeded();
 await expect(frame.locator('#result')).toContainText('检测完成');
 await page.locator('#muse-frame').screenshot({path:info.outputPath('fingerprint-selfcheck.png')});
 await page.locator('#fp-reset').click();
 await expect(page.locator('#fp-enabled')).not.toBeChecked();
 await expect(frame.locator('#result')).toContainText('兼容模式');
 expect((await api(`/api/accounts/${firstId}`)).account.fp.enabled).toBe(false);
});
