import net, { type AddressInfo, type Socket } from 'node:net';

/** Parse a complete TLS record containing a ClientHello; normalize only GREASE/order. */
export function parseClientHello(record: Buffer) {
  let offset = 9 + 2 + 32;
  offset += 1 + record[offset]!;
  const cipherLength = record.readUInt16BE(offset); offset += 2;
  const ciphers: number[] = [];
  for (let n = 0; n < cipherLength; n += 2) ciphers.push(record.readUInt16BE(offset + n));
  offset += cipherLength;
  offset += 1 + record[offset]!;
  const end = offset + 2 + record.readUInt16BE(offset); offset += 2;
  const extensions: number[] = [];
  const alpn: string[] = [];
  for (; offset < end;) {
    const type = record.readUInt16BE(offset); const length = record.readUInt16BE(offset + 2); offset += 4;
    extensions.push(type);
    if (type === 16) for (let n = offset + 2; n < offset + length;) { const size = record[n++]!; alpn.push(record.subarray(n, n + size).toString()); n += size; }
    offset += length;
  }
  const grease = (value: number) => (value & 0x0f0f) === 0x0a0a && (value >> 8) === (value & 255);
  return { ciphers: ciphers.filter(value => !grease(value)), extensions: extensions.filter(value => !grease(value)).sort((a, b) => a - b), alpn, grease: ciphers.some(grease) && extensions.some(grease) };
}

export async function captureHello(connect: (port: number) => Promise<unknown>) {
  const sockets = new Set<Socket>();
  let capture!: (data: Buffer) => void;
  const hello = new Promise<Buffer>(resolve => { capture = resolve; });
  const server = net.createServer(socket => {
    sockets.add(socket); let chunks = Buffer.alloc(0);
    socket.on('data', chunk => {
      chunks = Buffer.concat([chunks, chunk]);
      if (chunks.length >= 5 && chunks.length >= chunks.readUInt16BE(3) + 5) { capture(chunks); socket.destroy(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const request = connect((server.address() as AddressInfo).port).catch(() => undefined);
    const result = parseClientHello(await hello);
    await request;
    return result;
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
