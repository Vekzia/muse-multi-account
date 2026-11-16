import { describe, expect, it } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from './server.js';

describe('createServer', () => {
  it('serves public health without disclosing configuration', async () => {
    const reservation = createHttpServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const dataDir = await mkdtemp(join(tmpdir(), 'muse-health-'));
    const app = await createServer({ logger: false, gatewayPort: port, gatewayCount: 1,
      config: { bind:'127.0.0.1', port:8787, accessToken:'test', upstreamOrigin:'https://muse.ai', dataDir, mode:'development' } });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    } finally {
      await app.close();
      await rm(dataDir, { recursive:true, force:true });
    }
  });
});
