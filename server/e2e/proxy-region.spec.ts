import { test, expect, type Page } from '@playwright/test';
import { createServer as httpServer, request as httpRequest, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

let app:FastifyInstance,upstream:Server,geo:Server,dataDir:string;
const proxies:Server[]=[], sockets:Array<import('node:stream').Duplex>=[];
const base='http://127.0.0.1:26877',token='region-browser-fixture';
let jpProxy='',deProxy='',geoCalls=0;
const auth={authorization:'Bearer '+token,'content-type':'application/json',connection:'close'};
async function api(path:string,method='GET',body?:unknown){const r=await fetch(base+path,{method,headers:auth,...(body!==undefined?{body:JSON.stringify(body)}:{})});expect(r.ok).toBe(true);return r.json() as Promise<any>;}
async function makeProxy(country:'JP'|'DE'){
 const proxy=httpServer();proxies.push(proxy);
 proxy.on('connect',(req,downstream,head)=>{
  const target=new URL('http://'+req.url);
  if(Number(target.port)===(geo.address() as {port:number}).port){
   downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
   // Terminate this fixture tunnel with a country-specific response; this also
   // proves each lookup reached the selected account proxy, not a direct URL.
   let bytes=Buffer.from(head);const respond=(chunk:Buffer)=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.includes('\r\n\r\n')){downstream.removeListener('data',respond);geoCalls++;const body=JSON.stringify({success:true,ip:country==='JP'?'203.0.113.11':'198.51.100.22',country_code:country,timezone:{id:country==='JP'?'Asia/Tokyo':'Europe/Berlin'}});downstream.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: '+Buffer.byteLength(body)+'\r\nConnection: close\r\n\r\n'+body);}};
   downstream.on('data',respond);if(bytes.length)respond(Buffer.alloc(0));sockets.push(downstream);return;
  }
  const remote=connect(Number(target.port),target.hostname,()=>{downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);downstream.pipe(remote);remote.pipe(downstream);});remote.on('error',()=>downstream.destroy());downstream.on('error',()=>remote.destroy());sockets.push(downstream,remote);
 });
 await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(proxy.address() as {port:number}).port}`;
}
test.beforeAll(async()=>{
 dataDir=await mkdtemp(join(tmpdir(),'muse-region-browser-'));
 geo=httpServer((_req,res)=>{res.statusCode=500;res.end('A direct provider request is a test failure');});await new Promise<void>(r=>geo.listen(0,'127.0.0.1',r));
 upstream=httpServer((req,res)=>{if(req.url==='/headers'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.headers));return;}res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head></head><body><h1>Muse fixture</h1></body></html>');});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 jpProxy=await makeProxy('JP');deProxy=await makeProxy('DE');
 app=await createServer({config:{bind:'127.0.0.1',port:26877,accessToken:token,upstreamOrigin:`http://127.0.0.1:${(upstream.address() as {port:number}).port}`,dataDir,mode:'development'},gatewayPort:26878,gatewayCount:2,regionEndpoint:`http://127.0.0.1:${(geo.address() as {port:number}).port}`});await app.listen({host:'127.0.0.1',port:26877});
 await api('/api/accounts','POST',{name:'Japan exit',proxy:jpProxy,fp:{enabled:true,uaMode:'windows',workerMode:'profile'}});
 await api('/api/accounts','POST',{name:'Germany exit',proxy:deProxy,fp:{enabled:true,uaMode:'windows',workerMode:'profile'}});
});
test.afterAll(async()=>{await app?.close();for(const socket of sockets)socket.destroy();for(const server of [...proxies,upstream,geo])if(server)await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});if(dataDir)await rm(dataDir,{recursive:true,force:true});});
async function inspect(page:Page){const frame=page.frameLocator('#muse-frame');await expect(frame.locator('#result')).toContainText('检测完成');return JSON.parse((await frame.locator('#observed').textContent())!);}
async function selectAccount(page:Page,id:number){if(await page.locator('#drawer-toggle').isVisible())await page.locator('#drawer-toggle').click();await page.locator(`[data-account-id="${id}"]`).click();}

test('uses each proxy exit region in page headers and Worker, changes on failover and preserves manual override',async({page},info)=>{
 await page.goto(base);await page.locator('#token-input').fill(token);await page.locator('#token-submit').click();
 await expect(page.locator('#fp-locale-mode')).toHaveValue('proxy');await expect(page.locator('#fp-timezone-mode')).toHaveValue('proxy');
 await page.locator('#fp-check').click();let observed=await inspect(page);
 expect(observed.language).toBe('ja-JP');expect(observed.timezone).toBe('Asia/Tokyo');expect(observed.worker.language).toBe('ja-JP');expect(observed.worker.timezone).toBe('Asia/Tokyo');expect(observed.proxyRegion.ip).toBe('203.0.113.11');
 let accountFrame=page.frames().find(f=>f.url().includes(':26878/'))!;expect(await accountFrame.evaluate(async()=>((await(await fetch('/headers')).json()) as Record<string,string>)['accept-language'])).toBe('ja-JP,ja;q=0.9');
 await selectAccount(page,2);observed=await inspect(page);expect(observed.language).toBe('de-DE');expect(observed.timezone).toBe('Europe/Berlin');expect(observed.worker.language).toBe('de-DE');
 const saved=(await api('/api/accounts/2')).account;expect(saved.fp.locale).toBe('');expect(saved.fp.timezone).toBe('');
 await api('/api/accounts/2','PATCH',{proxyPool:[deProxy,jpProxy]});await page.locator('#proxy-failover-button').click();
 await page.locator('#fp-check').click();observed=await inspect(page);expect(observed.language).toBe('ja-JP');expect(observed.timezone).toBe('Asia/Tokyo');
 await page.locator('#fp-locale-mode').selectOption('manual');await page.locator('#fp-timezone-mode').selectOption('manual');await page.locator('#fp-locale').fill('fr-CA');await page.locator('#fp-timezone').fill('America/Toronto');page.on('dialog',d=>d.accept());await page.locator('#fp-save').click();observed=await inspect(page);expect(observed.language).toBe('fr-CA');expect(observed.timezone).toBe('America/Toronto');
 await page.locator('#region-sync').click();await expect(page.locator('#region-state')).toContainText('已识别');expect(await page.locator('#fp-locale').inputValue()).toBe('fr-CA');
 expect(geoCalls).toBeGreaterThanOrEqual(3);expect((await api('/api/accounts/2')).account.fp.seed).toBe(saved.fp.seed);
 await page.locator('#region-panel').scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('proxy-exit-region.png'),fullPage:true});
});
