import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';

const PUBLIC_FILES = new Map<string, { file: string; type: string }>([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'application/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
]);

export interface WebUiOptions { publicDir?: string }

async function sendAsset(reply: FastifyReply, publicDir: string, path: string): Promise<void> {
  const asset = PUBLIC_FILES.get(path);
  if (!asset) {
    reply.code(404).send({ error: 'Not found' });
    return;
  }
  try {
    const content = await readFile(resolve(publicDir, asset.file));
    reply.header('Content-Type', asset.type).header('Cache-Control', 'no-cache, no-store').header('X-Content-Type-Options', 'nosniff');
    if (path === '/' || path === '/index.html') {
      reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-src http: https:; form-action http: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
    reply.send(content);
  } catch {
    reply.code(404).send({ error: 'Not found' });
  }
}

export function registerWebUi(app: FastifyInstance, options: WebUiOptions = {}): void {
  const publicDir = options.publicDir ?? fileURLToPath(new URL('../../public/', import.meta.url));
  app.get('/', async (_request, reply) => sendAsset(reply, publicDir, '/'));
  app.get('/index.html', async (_request, reply) => sendAsset(reply, publicDir, '/index.html'));
  app.get('/app.js', async (_request, reply) => sendAsset(reply, publicDir, '/app.js'));
  app.get('/styles.css', async (_request, reply) => sendAsset(reply, publicDir, '/styles.css'));
}
