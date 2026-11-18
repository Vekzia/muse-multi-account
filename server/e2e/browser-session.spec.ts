import { test, expect } from '@playwright/test';
import { createServer as httpServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';
let app:FastifyInstance, upstream:Server, dataDir:string;
let blocked=false,wakes=0,checks=0;
const base='http://127.0.0.1:26477',token='browser-session-e2e';
test.beforeAll(async()=>{
 dataDir=await mkdtemp(join(tmpdir(),'muse-browser-session-'));
 upstream=httpServer((req,res)=>{
  if(req.url==='/login'){res.setHeader('Set-Cookie','hatch_sess=fixture; Path=/; Max-Age=7200');res.end('ok');return;}
  if(req.url==='/api/session'){checks++;res.setHeader('Content-Type','application/json');if(blocked){res.statusCode=403;res.end('{}');return;}res.setHeader('Set-Cookie','hatch_sess=rotated; Path=/; Max-Age=10800');res.end(JSON.stringify({status:'assigned',vm_state:wakes?'RUNNING':'SLEEPING',vm_id:'private-fixture'}));return;}
  if(req.url==='/api/hatch/vm/wake'){wakes++;res.end('{}');return;}
  if(req.url==='/worker.js'){res.setHeader('Content-Type','application/javascript');res.end("postMessage({ua:navigator.userAgent,locale:navigator.language,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,gpu:!!navigator.gpu});");return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head></head><body><h1>Muse fixture</h1><button id="login" onclick="fetch(\'/login\').then(()=>this.textContent=\'Logged\')">Login</button></body></html>');
 });
 await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 app=await createServer({config:{bind:'127.0.0.1',port:26477,accessToken:token,upstreamOrigin:`http://127.0.0.1:${(upstream.address() as {port:number}).port}`,dataDir,mode:'development'},gatewayPort:26478,gatewayCount:2});await app.listen({host:'127.0.0.1',port:26477});
 const a=await app.inject({method:'POST',url:'/api/accounts',headers:{authorization:'Bearer '+token},payload:{name:'完整配置'}});expect(a.statusCode).toBe(201);
});
test.afterAll(async()=>{await app?.close();if(upstream)await new Promise<void>(r=>{upstream.close(()=>r());upstream.closeAllConnections();});if(dataDir)await rm(dataDir,{recursive:true,force:true});});
test('account gateway applies transport/worker/font/GPU and preserves actual session state',async({page},info)=>{
 await page.goto(base);await page.locator('#token-input').fill(token);await page.locator('#token-submit').click();
 await page.locator('#fp-enabled').check();await page.locator('#fp-mode').selectOption('windows');await page.locator('#fp-locale-mode').selectOption('manual');await page.locator('#fp-timezone-mode').selectOption('manual');await page.locator('#fp-locale').fill('de-DE');await page.locator('#fp-timezone').fill('Europe/Berlin');
 await page.locator('#fp-advanced').evaluate(e=>e.setAttribute('open',''));
 await page.locator('#fp-tls').selectOption('chrome142');await page.locator('#fp-worker').selectOption('profile');await page.locator('#fp-font').selectOption('standard');await page.locator('#fp-webgpu').selectOption('disabled');
 page.on('dialog',d=>d.accept());await page.locator('#fp-save').click();await expect(page.locator('#fp-status')).toContainText('已保存');
 await page.locator('#launch-button').click();let frame=page.frameLocator('#muse-frame');await expect(frame.getByRole('heading',{name:'Muse fixture'})).toBeVisible();await frame.locator('#login').click();await expect(frame.locator('#login')).toHaveText('Logged');
 await page.locator('#fp-check').click();frame=page.frameLocator('#muse-frame');await expect(frame.locator('#result')).toContainText('检测完成');
 const actual=await frame.locator('#observed').textContent();const result=JSON.parse(actual!);
 expect(result.userAgent).toContain('Chrome/142.');expect(result.worker.ua).toBe(result.userAgent);expect(result.worker.language).toBe('de-DE');expect(result.worker.webGPU).toBe(false);expect(result.webGPU.exposed).toBe(false);expect(result.font.loaded).toBe(true);expect(result.font.family).toContain('Muse Standard');
 const accountFrame=page.frames().find(f=>f.url().includes(':26478/'))!;
 const urlWorker=await accountFrame.evaluate(()=>new Promise<any>((resolve,reject)=>{const w=new Worker('/worker.js');w.onmessage=e=>{w.terminate();resolve(e.data)};w.onerror=()=>{w.terminate();reject(new Error('worker error'))}}));expect(urlWorker.ua).toBe(result.userAgent);
 await page.locator('#session-check').click();await expect(page.locator('#session-state')).toContainText('有效');expect(checks).toBeGreaterThan(0);expect(wakes).toBe(0);await expect(page.locator('#session-cookie-expiry')).not.toHaveText('—');
 await page.locator('#session-enabled').check();await page.locator('#session-interval').fill('60');await page.locator('#session-wake').check();await page.locator('#session-save').click();await expect(page.locator('#session-status')).toContainText('保存');
 await page.locator('#session-check').click();await expect(page.locator('#session-vm-state')).toContainText('运行中');expect(wakes).toBe(1);
 blocked=true;await page.locator('#session-check').click();await expect(page.locator('#session-state')).toContainText('受限');await expect(page.locator('#token-dialog')).not.toBeVisible();
 await page.locator('#session-form').scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('browser-session-settings.png'),fullPage:true});
 await page.locator('#muse-frame').scrollIntoViewIfNeeded();await page.locator('#muse-frame').screenshot({path:info.outputPath('browser-session-selfcheck.png')});
});
