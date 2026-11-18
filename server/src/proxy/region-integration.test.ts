import { afterEach, describe, expect, it } from 'vitest';
import { createServer as httpServer, type RequestListener } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const c of cleanups.splice(0).reverse())await c();});
const auth={authorization:'Bearer region-fixture'};
async function endpoint(handler:RequestListener){const server=httpServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanups.push(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function proxy(){const server=httpServer();const sockets:Array<import('node:stream').Duplex>=[];server.on('connect',(req,socket,head)=>{const target=new URL('http://'+req.url);const remote=connect(Number(target.port),target.hostname,()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);socket.pipe(remote);remote.pipe(socket);});remote.on('error',()=>socket.destroy());sockets.push(socket,remote);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanups.push(()=>new Promise<void>(r=>{sockets.forEach(s=>s.destroy());server.close(()=>r());}));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function setup(regionEndpoint:string){const dataDir=await mkdtemp(join(tmpdir(),'muse-region-'));cleanups.push(()=>rm(dataDir,{recursive:true,force:true}));const upstream=await endpoint((req,res)=>{if(req.url==='/headers'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.headers));return;}res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head></head><body>fixture</body></html>');});
 const app=await createServer({config:{bind:'127.0.0.1',port:26777,accessToken:'region-fixture',upstreamOrigin:upstream,dataDir,mode:'development'},gatewayPort:26778,gatewayCount:3,regionEndpoint} as Parameters<typeof createServer>[0]);cleanups.push(()=>app.close());await app.ready();return app;}
async function add(app:Awaited<ReturnType<typeof setup>>,proxyUrl:string,fp:Record<string,unknown>={}){const r=await app.inject({method:'POST',url:'/api/accounts',headers:auth,payload:{name:'Proxy account',proxy:proxyUrl,fp:{enabled:true,uaMode:'windows',...fp}}});expect(r.statusCode).toBe(201);return r.json().account;}
async function launch(app:Awaited<ReturnType<typeof setup>>,id:number){const r=await app.inject({method:'POST',url:'/api/session',headers:auth,payload:{accountId:id}});expect(r.statusCode).toBe(201);const opened=await fetch(r.json().url,{method:'POST',body:new URLSearchParams({token:r.json().token}),redirect:'manual'});expect(opened.status).toBe(302);return {origin:new URL(r.json().url).origin,cookie:opened.headers.get('set-cookie')!.split(';')[0]!};}
describe('account proxy exit region composition',()=>{
 it('uses proxied exit data for launch/header/selfcheck without saving inferred values as manual',async()=>{
  let queries=0;const geo=await endpoint((req,res)=>{queries++;expect(req.headers.cookie).toBeUndefined();expect(req.headers.authorization).toBeUndefined();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,ip:'203.0.113.17',country_code:'NZ',timezone:{id:'Pacific/Auckland'}}));});
  const app=await setup(geo),account=await add(app,await proxy());
  expect((await app.inject({url:`/api/accounts/${account.id}/proxy/region`,headers:auth})).statusCode).toBe(200);expect(queries).toBe(0);
  const opened=await launch(app,account.id);const headers=await(await fetch(opened.origin+'/headers',{headers:{cookie:opened.cookie,'Accept-Language':'de-DE'}})).json() as Record<string,string>;
  expect(headers['accept-language']).toBe('en-NZ,en;q=0.9');expect(queries).toBe(1);
  const check=await(await fetch(opened.origin+'/__muse/fingerprint',{headers:{cookie:opened.cookie}})).text();expect(check).toContain('Pacific/Auckland');expect(check).toContain('en-NZ');
  const saved=(await app.inject({url:`/api/accounts/${account.id}`,headers:auth})).json().account;expect(saved.fp.locale).toBe('');expect(saved.fp.localeMode).toBe('proxy');expect(saved.fp.seed).toBe(account.fp.seed);
 });
 it('keeps explicit manual overrides and makes a failed automatic lookup visible without target access',async()=>{
  const geo=await endpoint((_req,res)=>{res.writeHead(502);res.end('private provider details');});const app=await setup(geo);const p=await proxy();const auto=await add(app,p);
  const failed=await app.inject({method:'POST',url:'/api/session',headers:auth,payload:{accountId:auto.id}});expect(failed.statusCode).toBe(503);expect(failed.body).not.toContain('private provider');
  const manual=await add(app,p,{locale:'ja-JP',timezone:'Asia/Tokyo',localeMode:'manual',timezoneMode:'manual'});const opened=await launch(app,manual.id);const observed=await(await fetch(opened.origin+'/headers',{headers:{cookie:opened.cookie}})).json() as Record<string,string>;expect(observed['accept-language']).toBe('ja-JP,ja;q=0.9');
  expect((await app.inject({method:'POST',url:`/%61pi/accounts/${auto.id}/proxy/region/sync`})).statusCode).toBe(401);
 });
});
