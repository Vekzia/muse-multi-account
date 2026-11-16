import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonStore } from './json-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'muse-json-store-'));
  directories.push(directory);
  return directory;
}

describe('JsonStore', () => {
  it('pins relative paths at construction even if the process directory changes', async () => {
    const original = process.cwd();
    const first = await makeDirectory();
    const second = await makeDirectory();
    try {
      process.chdir(first);
      const store = new JsonStore('state.json', { value: 1 });
      process.chdir(second);
      store.write({ value: 2 });
      expect(JSON.parse(await readFile(join(first, 'state.json'), 'utf8'))).toEqual({ value: 2 });
      expect(await readdir(second)).toEqual([]);
    } finally {
      process.chdir(original);
    }
  });

  it('replaces the file instead of truncating a reader-held file descriptor', async () => {
    const directory = await makeDirectory();
    const file = join(directory, 'state.json');
    const store = new JsonStore(file, { value: 'before' });
    store.write({ value: 'before' });
    const reader = openSync(file, 'r');
    try {
      store.write({ value: 'after' });
      expect(JSON.parse(readFileSync(reader, 'utf8'))).toEqual({ value: 'before' });
      expect(store.read()).toEqual({ value: 'after' });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      closeSync(reader);
    }
  });

  it('does not include persisted secret values in corrupt-JSON errors', async () => {
    const directory = await makeDirectory();
    const file = join(directory, 'state.json');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, 'PRIVATE_SECRET is not JSON', 'utf8'));
    const store = new JsonStore(file, {});
    try {
      store.read();
      expect.fail('corrupt JSON should fail');
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE_SECRET');
      expect(String(error)).toContain('JSON');
    }
  });

  it('creates the data directory, writes atomically, and reloads JSON', async () => {
    const directory = await makeDirectory();
    const file = join(directory, 'nested', 'state.json');
    const store = new JsonStore<{ version: number; accounts: Array<{ id: number }> }>(file, { version: 1, accounts: [] });

    expect(await store.read()).toEqual({ version: 1, accounts: [] });
    await store.write({ version: 2, accounts: [{ id: 7 }] });

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, accounts: [{ id: 7 }] });
    expect(await new JsonStore(file, { version: 0, accounts: [] }).read()).toEqual({ version: 2, accounts: [{ id: 7 }] });
    expect((await readdir(join(directory, 'nested'))).filter((entry) => entry.includes('.tmp.'))).toEqual([]);
  });

  it('does not replace an existing file when serialization fails', async () => {
    const directory = await makeDirectory();
    const file = join(directory, 'state.json');
    const store = new JsonStore(file, { value: 'original' });
    await store.write({ value: 'original' });

    expect(() => store.write({ value: BigInt(1) } as unknown as { value: string })).toThrow();
    expect(await readFile(file, 'utf8')).toContain('original');
  });

  it('rejects malformed persisted JSON instead of silently returning defaults', async () => {
    const directory = await makeDirectory();
    const file = join(directory, 'state.json');
    const store = new JsonStore(file, { value: 'default' });
    await store.write({ value: 'valid' });
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, '{bad', 'utf8'));

    expect(() => store.read()).toThrow(/JSON|Unexpected token/);
  });

  it('keeps the persisted file a regular file after a write', async () => {
    const directory = await makeDirectory();
    const file = join(directory, 'state.json');
    const store = new JsonStore(file, { value: 1 });
    await store.write({ value: 2 });

    expect((await stat(file)).isFile()).toBe(true);
  });
});
