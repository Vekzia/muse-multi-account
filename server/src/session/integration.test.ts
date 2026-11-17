import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as httpServer, type RequestListener, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { createServer } from '../server.js';
import { AccountCookieJar } from '../proxy/cookie-jar.js';

const disposals: Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const d of disposals.splice(0).reverse())await d();});
const headers={authorization:'Bearer session-fixture'};
async function setup(handler: RequestListener){
 const upstream=httpServer(handler);await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 disposals.push(()=>new Promise<void>(r=>{upstream.close(()=>r());upstream.closeAllConnections();}));
 const origin=`http://127.0.0.1:${(upstream.address() as {port:number}).port}`;
 const dataDir=await mkdtemp(join(tmpdir(),'muse-session-int-'));disposals.push(()=>rm(dataDir,{recursive:true,force:true}));
 const app=await createServer({config:{bind:'127.0.0.1',port:26377,upstreamOrigin:origin,dataDir,accessToken:'session-fixture',mode:'development'},gatewayPort:26378,gatewayCount:2});disposals.push(()=>app.close());
 const created=await app.inject({method:'POST',url:'/api/accounts',headers,payload:{name:'Session A'}});const id=created.json().account.id;
 const jars=new AccountCookieJar(dataDir); const jar=await jars.get(id);await jar.setCookie('hatch_sess=real-fixture; Path=/; Max-Age=7200',origin);await jars.save(id,jar);
 return{app,id,origin,dataDir};
}
function deferred() {
 let resolve!: () => void;
 const promise = new Promise<void>(done => { resolve = done; });
 return { promise, resolve };
}
async function proxyFixture() {
 const sockets = new Set<Socket>();
 const proxy = httpServer();
 proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
 proxy.on('connect', (req, client, head) => {
  const target = new URL(`http://${req.url}`);
  const upstream = connect(Number(target.port), target.hostname, () => {
   client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
   if (head.length) upstream.write(head);
   client.pipe(upstream).pipe(client);
  });
  sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
  upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  client.on('close', () => upstream.destroy());
 });
 await new Promise<void>(done => proxy.listen(0, '127.0.0.1', done));
 disposals.push(() => new Promise<void>(done => { for (const socket of sockets) socket.destroy(); proxy.close(() => done()); }));
 return `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
}

describe('session maintenance composition',()=>{
 it('persists actual rotated cookies without deadlocking manual checks or sending admin auth',async()=>{
  let cookie='',auth='',wake=0;
  const{app,id,dataDir}=await setup((req,res)=>{cookie=req.headers.cookie??'';auth=req.headers.authorization??'';if(req.url?.includes('/wake'))wake++;res.setHeader('Content-Type','application/json');res.setHeader('Set-Cookie','hatch_sess=rotated; Path=/; Max-Age=10800');res.end(JSON.stringify({status:'assigned',vm_state:'RUNNING',vm_id:'private-vm'}));});
  const check=await app.inject({method:'POST',url:`/api/accounts/${id}/session/check`,headers});
  expect(check.statusCode).toBe(200);expect(check.json().status.state).toBe('healthy');expect(cookie).toContain('hatch_sess=real-fixture');expect(auth).toBe('');expect(wake).toBe(0);
  expect(check.body).not.toContain('private-vm');expect(check.body).not.toContain('rotated');
  const stored=await new AccountCookieJar(dataDir).get(id);expect(stored.toJSON()?.cookies?.some(c=>c.value==='rotated')).toBe(true);
  expect((await app.inject({url:`/api/accounts/${id}/session`,headers})).json().status.lastSuccess).toBeGreaterThan(0);
 });
 it('cancels late cookie/status writes when cookies are cleared during a check',async()=>{
  let release!:()=>void;let started!:()=>void;const began=new Promise<void>(r=>started=r);const wait=new Promise<void>(r=>release=r);
  const{app,id,dataDir}=await setup(async(_req,res)=>{started();await wait;res.setHeader('Set-Cookie','hatch_sess=late; Path=/');res.setHeader('Content-Type','application/json');res.end('{"status":"assigned","vm_state":"RUNNING"}');});
  const pending=app.inject({method:'POST',url:`/api/accounts/${id}/session/check`,headers});await began;
  const cleared=await app.inject({method:'POST',url:`/api/accounts/${id}/cookies/clear`,headers});expect(cleared.statusCode).toBe(200);release();await pending;
  const jar=await new AccountCookieJar(dataDir).get(id);expect(jar.toJSON()?.cookies).toEqual([]);
  const status=await app.inject({url:`/api/accounts/${id}/session`,headers});expect(status.json().status.state).not.toBe('healthy');
 });
 it.each(['fp', 'proxy', 'proxyPool', 'generate', 'failover'] as const)(
  'invalidates late probes after a successful %s change, preventing stale cookies, health and wake', async change => {
   const began = deferred();
   let oldResponse!: ServerResponse;
   let checks = 0, wakes = 0;
   const { app, id, dataDir } = await setup((req, res) => {
    if (req.url === '/api/hatch/vm/wake') { wakes++; res.end('{}'); return; }
    checks++;
    if (checks === 2) { oldResponse = res; began.resolve(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end('{"status":"assigned","vm_state":"RUNNING"}');
   });
   const proxies = change === 'failover' ? [await proxyFixture(), await proxyFixture()] : [];
   const enabled = await app.inject({ method: 'PATCH', url: `/api/accounts/${id}`, headers,
    payload: { keepAlive: { enabled: true, intervalMinutes: 30, wakeVm: true }, ...(proxies.length ? { proxy: proxies[0], proxyPool: proxies } : {}) } });
   expect(enabled.statusCode).toBe(200);
   expect((await app.inject({ method: 'POST', url: `/api/accounts/${id}/session/check`, headers })).json().status.state).toBe('healthy');
   const pending = app.inject({ method: 'POST', url: `/api/accounts/${id}/session/check`, headers });
   await began.promise;
   const payload = change === 'fp' ? { fp: { timezone: 'Asia/Shanghai' } }
    : change === 'proxy' ? { proxy: 'http://127.0.0.1:9' }
    : { proxyPool: ['http://127.0.0.1:9'] };
   let changed;
   try {
    changed = change === 'generate'
     ? await app.inject({ method: 'POST', url: `/api/accounts/${id}/fingerprint/generate`, headers, payload: { mode: 'windows' } })
     : change === 'failover'
      ? await app.inject({ method: 'POST', url: `/api/accounts/${id}/proxy/failover`, headers })
      : await app.inject({ method: 'PATCH', url: `/api/accounts/${id}`, headers, payload });
   } finally {
    oldResponse.setHeader('Set-Cookie', 'hatch_sess=late-config-cookie; Path=/; Max-Age=7200');
    oldResponse.setHeader('Content-Type', 'application/json');
    oldResponse.end('{"status":"assigned","vm_id":"private-old-vm","vm_state":"STOPPED"}');
   }
   const oldResult = await pending;
   expect(changed.statusCode).toBe(200);
   expect(oldResult.json().status.state).toBe('unknown');
   expect(wakes).toBe(0);
   const status = (await app.inject({ url: `/api/accounts/${id}/session`, headers })).json().status;
   expect(status).toMatchObject({ state: 'unknown', lastCheck: null, lastSuccess: null });
   expect(status.nextCheck).toBeGreaterThan(Date.now());
   const jar = await new AccountCookieJar(dataDir).get(id);
   expect(jar.toJSON()?.cookies?.some(cookie => cookie.value === 'late-config-cookie')).toBe(false);
   expect(jar.toJSON()?.cookies?.some(cookie => cookie.value === 'real-fixture')).toBe(true);
  },
 );

 it('keeps completed health after metadata-only account updates', async () => {
  const { app, id } = await setup((_req, res) => res.end('{"status":"assigned","vm_state":"RUNNING"}'));
  const before = (await app.inject({ method: 'POST', url: `/api/accounts/${id}/session/check`, headers })).json().status;
  const changed = await app.inject({ method: 'PATCH', url: `/api/accounts/${id}`, headers, payload: { name: 'Renamed account' } });
  expect(changed.statusCode).toBe(200);
  expect((await app.inject({ url: `/api/accounts/${id}/session`, headers })).json().status).toEqual(before);
 });

 it.each(['fp', 'generate', 'failover'] as const)('preserves an in-flight probe when %s mutation fails', async change => {
  const began = deferred();
  let response!: ServerResponse;
  const { app, id, dataDir } = await setup((_req, res) => { response = res; began.resolve(); });
  const pending = app.inject({ method: 'POST', url: `/api/accounts/${id}/session/check`, headers });
  await began.promise;
  let changed;
  try {
   changed = change === 'generate'
    ? await app.inject({ method: 'POST', url: `/api/accounts/${id}/fingerprint/generate`, headers: { ...headers, 'if-match': '999' }, payload: { mode: 'windows' } })
    : change === 'failover'
     ? await app.inject({ method: 'POST', url: `/api/accounts/${id}/proxy/failover`, headers })
     : await app.inject({ method: 'PATCH', url: `/api/accounts/${id}`, headers: { ...headers, 'if-match': '999' }, payload: { fp: { timezone: 'Asia/Shanghai' } } });
  } finally {
   response.setHeader('Set-Cookie', 'hatch_sess=still-current; Path=/; Max-Age=7200');
   response.end('{"status":"assigned","vm_state":"RUNNING"}');
  }
  expect(changed.statusCode).toBe(409);
  expect((await pending).json().status.state).toBe('healthy');
  const jar = await new AccountCookieJar(dataDir).get(id);
  expect(jar.toJSON()?.cookies?.some(cookie => cookie.value === 'still-current')).toBe(true);
 });

 it('keeps VM wake opt-in and never turns a 403 into a false expiration',async()=>{
  let wakes=0;const{app,id}=await setup((req,res)=>{if(req.url?.includes('/wake'))wakes++;res.writeHead(403,{'Content-Type':'text/plain'});res.end('private upstream detail');});
  const check=await app.inject({method:'POST',url:`/api/accounts/${id}/session/check`,headers});expect(check.json().status.state).toBe('blocked');expect(check.body).not.toContain('private upstream');expect(wakes).toBe(0);
 });
});
