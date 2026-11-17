import type { IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import type { BrowserProfile } from 'wreq-js';
import { parseProxy } from './proxy-url.js';
import { stripHopHeaders } from './upstream.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
function workerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?|all|no)_proxy$/i.test(name)));
}
let activeRequests = 0;
const waiting: Array<() => void> = [];
async function acquireRequest(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) throw abortError(signal);
  if (activeRequests >= 8) {
    if (waiting.length >= 32) throw new Error('Browser transport capacity exceeded');
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { const index = waiting.indexOf(ready); if (index !== -1) waiting.splice(index, 1); reject(abortError(signal)); };
      waiting.push(ready);
      signal.addEventListener('abort', abort, { once: true });
    });
  } else activeRequests++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiting.shift();
    if (next) next(); else activeRequests--;
  };
}
const PROFILES: Record<BrowserRequestOptions['profile'], BrowserProfile> = { chrome131: 'chrome_131', chrome142: 'chrome_142' };
function timeoutValue(value = 30_000): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('timeoutMs must be a non-negative finite number');
  return value;
}
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Browser transport aborted');
}
function headerTuples(headers: IncomingHttpHeaders): Array<[string, string]> {
  return Object.entries(headers).flatMap(([key, value]) => value === undefined ? [] :
    (Array.isArray(value) ? value : [value]).map(part => [key, part] as [string, string]));
}
async function uploadBytes(body: BrowserRequestOptions['body'], signal: AbortSignal): Promise<Buffer | undefined> {
  if (signal.aborted) { if (body instanceof Readable) body.destroy(); throw abortError(signal); }
  if (body === undefined) return undefined;
  if (!(body instanceof Readable)) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('Browser upload exceeds 25 MiB');
    return bytes;
  }
  const abort = () => body.destroy(abortError(signal));
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      if (signal.aborted) throw abortError(signal);
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw new TypeError('Upload chunks must be strings or bytes');
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_UPLOAD_BYTES) throw new Error('Browser upload exceeds 25 MiB');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', abort);
    if (!body.readableEnded) body.destroy();
  }
}

export interface BrowserRequestOptions {
  url: string;
  method?: string;
  headers: IncomingHttpHeaders;
  body?: Buffer | string | Readable;
  proxy?: string;
  profile: 'chrome131' | 'chrome142';
  os: 'windows' | 'macos' | 'android' | 'linux';
  timeoutMs?: number;
  signal?: AbortSignal;
}
// wreq 3.2.0 cancelBody invalidates a native cache entry but can retain the active
// socket. A short-lived process makes cancellation deterministic without a Node
// HTTP/TLS fallback. IPC pulls one chunk at a time, preserving backpressure.
const HTTP_WORKER = `
process.on('disconnect', () => process.exit());
let reader;
process.on('message', async message => {
  try {
    if (message.kind === 'start') {
      const { fetch } = await import(message.moduleUrl);
      const response = await fetch(message.url, message.options);
      reader = response.body?.getReader();
      const headers = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers['set-cookie'] = cookies;
      process.send({ kind: 'headers', statusCode: response.status, headers });
    } else if (message.kind === 'pull') {
      const next = reader ? await reader.read() : { done: true };
      process.send(next.done ? { kind: 'end' } : { kind: 'chunk', bytes: Buffer.from(next.value) });
    }
  } catch (error) { process.send({ kind: 'error', message: String(error?.message ?? error) }); }
});
`;

export type BrowserWebSocketOptions = Omit<BrowserRequestOptions, 'method' | 'body'> & { protocols?: string | string[] };
export interface BrowserSocketMessageEvent { data: string | Buffer }
export interface BrowserSocketCloseEvent { code: number; reason: string; wasClean: boolean }
export interface BrowserSocketErrorEvent { message: string }
/** Supported wreq WebSocket surface, bridged across a cancellable process. */
export interface BrowserSocket {
  readonly readyState: number;
  readonly protocol: string;
  readonly bufferedAmount: number;
  send(data: string | Buffer | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'close', listener: (event: BrowserSocketCloseEvent) => void, options?: { once?: boolean }): void;
  addEventListener(type: 'error', listener: (event: BrowserSocketErrorEvent) => void, options?: { once?: boolean }): void;
  addEventListener(type: 'message', listener: (event: BrowserSocketMessageEvent) => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: never): void;
}
export interface BrowserWebSocketConnection {
  socket: BrowserSocket;
  onMessage(listener: (event: BrowserSocketMessageEvent) => void): () => void;
  close(): Promise<void>;
}
const WS_WORKER = `
process.on('disconnect', () => process.exit());
let socket, session, pendingBytes = 0;
const emit = message => process.send(message);
process.on('message', async message => {
  try {
    if (message.kind === 'start') {
      const { createSession } = await import(message.moduleUrl);
      session = await createSession(message.session);
      socket = await session.websocket({ ...message.options,
        onMessage(data) {
          pendingBytes += Buffer.byteLength(data);
          if (pendingBytes > 16 * 1024 * 1024) { emit({kind:'error',message:'WebSocket receive queue exceeds 16 MiB'}); return; }
          emit({ kind:'message', data });
        },
        onClose(event) { emit({kind:'close',code:event.code,reason:event.reason,wasClean:event.wasClean}); void session.close(); },
        onError(message) { emit({kind:'error',message}); void session.close(); },
      });
      emit({kind:'open',protocol:socket.protocol});
    } else if (message.kind === 'send') {
      socket.send(message.data);
      while(socket.bufferedAmount && socket.readyState === 1) await new Promise(resolve => setTimeout(resolve, 5));
      emit({kind:'sent',size:Buffer.byteLength(message.data)});
    } else if (message.kind === 'ack') pendingBytes -= message.size;
    else if (message.kind === 'close') { socket?.close(message.code, message.reason); await session?.close(); }
  } catch(error) { emit({kind:'error',message:String(error?.message ?? error)}); }
});
`;

/** 101 headers/Set-Cookie unavailable upstream: only HTTP responses rotate the external jar. */
export async function browserWebSocket(options: BrowserWebSocketOptions): Promise<BrowserWebSocketConnection> {
  const timeoutMs = timeoutValue(options.timeoutMs);
  const proxy = options.proxy === undefined ? undefined : parseProxy(options.proxy).url;
  const controller = new AbortController();
  const externalAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs) { timer = setTimeout(() => controller.abort(new Error('Browser WebSocket timed out')), timeoutMs); timer.unref(); }
  let release: (() => void) | undefined;
  let worker: ChildProcess | undefined;
  let rejectOpen: ((error: Error) => void) | undefined;
  let state = 0;
  let protocol = '';
  let bufferedAmount = 0;
  let exitDone!: () => void;
  const exited = new Promise<void>(resolve => { exitDone = resolve; });
  const events = new EventTarget();
  const queue: Array<string | Buffer> = [];
  const listeners = new Set<(event: BrowserSocketMessageEvent) => void>();
  const emit = (type: string, data: object) => events.dispatchEvent(Object.assign(new Event(type), data));
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', externalAbort);
    controller.signal.removeEventListener('abort', abort);
    state = 3; queue.length = 0;
    if (worker) worker.kill('SIGKILL'); else { release?.(); exitDone(); }
  };
  const fail = (error: Error) => {
    rejectOpen?.(error);
    if (state === 1) { emit('error', { message: error.message }); emit('close', {code:1006,reason:'',wasClean:false}); }
    cleanup();
  };
  const abort = () => fail(abortError(controller.signal));
  controller.signal.addEventListener('abort', abort, { once: true });
  const send = (message: object) => { if (worker?.connected) worker.send(message, error => { if (error && state < 2) fail(error); }); };
  const socket: BrowserSocket = {
    get readyState() { return state; }, get protocol() { return protocol; }, get bufferedAmount() { return bufferedAmount; },
    send(data) {
      if (state !== 1) throw new Error('WebSocket is not open');
      const payload = typeof data === 'string' || Buffer.isBuffer(data) ? data : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);
      const size = Buffer.byteLength(payload);
      if (bufferedAmount + size > 16 * 1024 * 1024) throw new Error('WebSocket send queue exceeds 16 MiB');
      bufferedAmount += size; send({kind:'send',data:payload});
    },
    close(code = 1000, reason = '') {
      if (state >= 2) return;
      state = 2; send({kind:'close',code,reason});
      if (timer) clearTimeout(timer);
      timer = setTimeout(cleanup, 250); timer.unref();
    },
    addEventListener: events.addEventListener.bind(events) as unknown as BrowserSocket['addEventListener'],
    removeEventListener: events.removeEventListener.bind(events),
  };
  const deliver = (data: string | Buffer) => {
    for (const listener of listeners) listener({data});
    emit('message', {data}); send({kind:'ack',size:Buffer.byteLength(data)});
  };
  try {
    release = await acquireRequest(controller.signal);
    if (controller.signal.aborted) throw abortError(controller.signal);
    const headers = stripHopHeaders(options.headers);
    delete headers.host;
    for (const key of Object.keys(headers)) if (key.startsWith('sec-websocket-')) delete headers[key];
    worker = spawn(process.execPath, ['--input-type=module', '--eval', WS_WORKER], { stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',env:workerEnvironment() });
    worker.once('exit', () => { release?.(); exitDone(); if (state < 2) fail(new Error('Browser WebSocket process exited')); });
    worker.once('error', fail);
    await new Promise<void>((resolve, reject) => {
      rejectOpen = reject;
      worker!.on('message', (message: unknown) => {
        const data = message as {kind:string;protocol:string;data:string|Buffer;message:string;size:number;code:number;reason:string;wasClean:boolean};
        if (data.kind === 'open') { state = 1; protocol = data.protocol; if (timer) clearTimeout(timer); resolve(); }
        else if (data.kind === 'message') { if (listeners.size) deliver(data.data); else queue.push(data.data); }
        else if (data.kind === 'sent') bufferedAmount = Math.max(0, bufferedAmount - data.size);
        else if (data.kind === 'close') { emit('close', {code:data.code,reason:data.reason,wasClean:data.wasClean}); cleanup(); }
        else if (data.kind === 'error') fail(new Error(data.message));
      });
      send({ kind:'start',moduleUrl:import.meta.resolve('wreq-js'),session:{browser:PROFILES[options.profile],os:options.os,...(proxy ? {proxy} : {})},
        options:{url:options.url,headers:headerTuples(headers),...(options.protocols ? {protocols:options.protocols} : {}),binaryType:'nodebuffer',maxFrameSize:16*1024*1024,maxMessageSize:16*1024*1024} });
    });
    return { socket, onMessage(listener) { listeners.add(listener); for (const data of queue.splice(0)) deliver(data); return () => listeners.delete(listener); },
      close() { socket.close(); return exited; } };
  } catch(error) { cleanup(); throw error; }
}

/** One isolated cookie context per call; the caller owns its persistent cookie jar. */
export async function browserRequest(options: BrowserRequestOptions): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Readable }> {
  const timeoutMs = timeoutValue(options.timeoutMs);
  const proxy = options.proxy === undefined ? undefined : parseProxy(options.proxy).url;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let worker: ChildProcess | undefined;
  let release: (() => void) | undefined;
  let output: Readable | undefined;
  let fail: ((error: Error) => void) | undefined;
  let ended = false;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const arm = () => {
    clearTimer();
    if (timeoutMs) { timer = setTimeout(() => controller.abort(new Error('Browser request timed out')), timeoutMs); timer.unref(); }
  };
  const externalAbort = () => controller.abort(options.signal?.reason);
  const cleanup = () => {
    clearTimer();
    options.signal?.removeEventListener('abort', externalAbort);
    controller.signal.removeEventListener('abort', abort);
    if (worker) worker.kill('SIGKILL'); else release?.();
  };
  const abort = () => {
    const error = abortError(controller.signal);
    if (output) output.destroy(error); else { fail?.(error); cleanup(); }
  };
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  controller.signal.addEventListener('abort', abort, { once: true });
  arm();
  try {
    release = await acquireRequest(controller.signal);
    const body = await uploadBytes(options.body, controller.signal);
    if (controller.signal.aborted) throw abortError(controller.signal);
    const headers = stripHopHeaders(options.headers);
    delete headers.host;
    if (body !== undefined) headers['content-length'] = String(body.length);
    else delete headers['content-length'];
    worker = spawn(process.execPath, ['--input-type=module', '--eval', HTTP_WORKER], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', env: workerEnvironment(),
    });
    const child = worker;
    const response = await new Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Readable }>((resolve, reject) => {
      fail = reject;
      let pulling = false;
      child.on('error', error => { if (output) output.destroy(error); else reject(error); });
      child.on('exit', () => {
        release?.();
        if (!ended && !output?.destroyed) {
          const error = new Error('Browser transport process exited');
          if (output) output.destroy(error); else reject(error);
        }
      });
      child.on('message', (message: unknown) => {
        const data = message as { kind: string; message?: string; statusCode: number; headers: IncomingHttpHeaders; bytes: Buffer };
        if (data.kind === 'headers') {
          clearTimer();
          output = new Readable({
            read() {
              if (pulling || ended) return;
              pulling = true;
              arm();
              if (child.connected) child.send({ kind: 'pull' }, error => { if (error) this.destroy(error); });
            },
            destroy(error, callback) { cleanup(); callback(error); },
          });
          output.on('error', () => undefined);
          arm();
          resolve({ statusCode: data.statusCode, headers: data.headers, body: output });
        } else if (data.kind === 'chunk') {
          clearTimer(); pulling = false; if (!output?.destroyed) output?.push(data.bytes);
        } else if (data.kind === 'end') {
          ended = true; cleanup(); output?.push(null);
        } else if (data.kind === 'error') {
          const error = new Error(data.message ?? 'Browser request failed');
          if (output) output.destroy(error); else reject(error);
        }
      });
      child.send({ kind: 'start', moduleUrl: import.meta.resolve('wreq-js'), url: options.url, options: {
        method: options.method ?? 'GET', headers: headerTuples(headers),
        ...(body !== undefined ? { body } : {}), ...(proxy !== undefined ? { proxy } : {}),
        browser: PROFILES[options.profile], os: options.os, cookieMode: 'ephemeral',
        redirect: 'manual', compress: false, timeout: 0, disableDefaultHeaders: true,
      } }, error => { if (error) reject(error); });
    });
    return response;
  } catch (error) {
    cleanup();
    if (controller.signal.aborted) throw abortError(controller.signal);
    throw error;
  }
}
