import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { AccountStore } from '../storage/account-store.js';
import { WebSocketServer, WebSocket } from 'ws';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const auth = {authorization:'Bearer fingerprint-test-secret'};
async function fixture() {
  const upstream = createHttpServer((req,res) => {
    if (req.url === '/headers') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(req.headers)); }
    else { res.setHeader('Content-Type','text/html'); res.setHeader('ETag','old'); res.end('<!doctype html><html><head><script>window.firstUa=navigator.userAgent</script></head><body>page</body></html>'); }
  });
  const wss = new WebSocketServer({server:upstream});
  wss.on('connection',(ws, req)=>ws.send(JSON.stringify(req.headers)));
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
  cleanup.push(()=>new Promise<void>(r=>{wss.clients.forEach(ws=>ws.terminate());wss.close();upstream.close(()=>r());upstream.closeAllConnections();}));
  const dataDir = await mkdtemp(join(tmpdir(),'muse-fp-integration-'));
  cleanup.push(()=>rm(dataDir,{recursive:true,force:true}));
  const store = new AccountStore(dataDir);
  const a = store.create({name:'profile A'}); const b = store.create({name:'profile B'});
  const app=await createServer({config:{bind:'127.0.0.1',port:25277,accessToken:'fingerprint-test-secret',upstreamOrigin:`http://127.0.0.1:${(upstream.address() as {port:number}).port}`,dataDir,mode:'development'},gatewayPort:25278,gatewayCount:2,logger:false});
  cleanup.push(()=>app.close()); await app.ready();
  return {app,store,a,b};
}
async function launch(app: Awaited<ReturnType<typeof fixture>>['app'], id:number, target='muse') {
 const response=await app.inject({method:'POST',url:'/api/session',headers:auth,payload:{accountId:id,target}});
 expect(response.statusCode).toBe(201);
 const opened=await fetch(response.json().url,{method:'POST',body:new URLSearchParams({token:response.json().token}),redirect:'manual'});
 expect(opened.status).toBe(302);
 return {cookie:opened.headers.get('set-cookie')!.split(';')[0]!,origin:new URL(response.json().url).origin,location:opened.headers.get('location')};
}
describe('fingerprint proxy integration',()=>{
 it('applies account UA/language to HTTP and WebSocket, never the other account',async()=>{
  const {app,store,a,b}=await fixture();
  store.update(a.id,{fp:{enabled:true,uaMode:'custom',uaCustom:'AccountOne/1.0',locale:'fr-FR',timezone:'Europe/Paris'}});
  const sa=await launch(app,a.id); const sb=await launch(app,b.id);
  const h={cookie:sa.cookie,'User-Agent':'ClientNative/9','Accept-Language':'en-US','Sec-CH-UA-Platform':'"Linux"'};
  const observed=await (await fetch(sa.origin+'/headers',{headers:h})).json() as Record<string,string>;
  expect(observed['user-agent']).toBe('AccountOne/1.0'); expect(observed['accept-language']).toContain('fr-FR'); expect(observed['sec-ch-ua-platform']).toBeUndefined();
  const other=await (await fetch(sb.origin+'/headers',{headers:{...h,cookie:sb.cookie}})).json() as Record<string,string>; expect(other['user-agent']).toBe('ClientNative/9');
  const ws=new WebSocket(sa.origin.replace('http:','ws:')+'/ws',{headers:h});
  const message=await new Promise<string>((resolve,reject)=>{ws.once('message',data=>resolve(data.toString()));ws.once('error',reject);}); ws.terminate();
  expect(JSON.parse(message)['user-agent']).toBe('AccountOne/1.0');
 });
 it('injects before upstream code, skips disabled profiles and prevents stale cached HTML',async()=>{
  const {app,store,a,b}=await fixture();
  store.update(a.id,{fp:{enabled:true,uaMode:'custom',uaCustom:'StableAccount/2'}});
  const sa=await launch(app,a.id);const sb=await launch(app,b.id);
  const response=await fetch(sa.origin,{headers:{cookie:sa.cookie}});const html=await response.text();
  expect(html).toContain('data-muse-fingerprint'); expect(html.indexOf('data-muse-fingerprint')).toBeLessThan(html.indexOf('window.firstUa'));
  expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('etag')).toBeNull();
  const off=await (await fetch(sb.origin,{headers:{cookie:sb.cookie}})).text();expect(off).not.toContain('data-muse-fingerprint');
 });
 it('serves a cookie-authenticated same-origin selfcheck without credential echo',async()=>{
  const {app,store,a}=await fixture(); store.update(a.id,{fp:{enabled:true,uaMode:'custom',uaCustom:'Selfcheck/3'}});
  const session=await launch(app,a.id,'fingerprint'); expect(session.location).toBe('/__muse/fingerprint');
  expect((await fetch(session.origin+'/__muse/fingerprint')).status).toBe(401);
  const result=await fetch(session.origin+'/__muse/fingerprint',{headers:{cookie:session.cookie,authorization:'Bearer MUST_NOT_ECHO'}});
  const html=await result.text();expect(result.status).toBe(200);expect(html).toContain('指纹自检');expect(html).toContain('Selfcheck/3');
  expect(html).not.toContain(session.cookie.split('=')[1]); expect(html).not.toContain('MUST_NOT_ECHO');
  expect((await app.inject({method:'POST',url:'/api/session',headers:auth,payload:{accountId:a.id,target:'https://external.test'}})).statusCode).toBe(400);
 });
});
