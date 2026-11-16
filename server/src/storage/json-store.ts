import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type JsonValidator<T> = (value: unknown) => T;

/**
 * Small JSON persistence primitive. Writes use a same-directory temporary file
 * followed by rename, so readers observe either the previous or next document.
 */
export class JsonStore<T> {
  private readonly validator: JsonValidator<T>;

  public constructor(
    private readonly filePath: string,
    private readonly initialValue: T,
    validator?: JsonValidator<T>,
  ) {
    this.filePath = resolve(filePath);
    this.validator = validator ?? ((value: unknown) => value as T);
  }

  public read(): T {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return clone(this.validator(parsed));
    } catch (error) {
      if (isMissingFile(error)) {
        const value = this.validator(clone(this.initialValue));
        this.write(value);
        return clone(value);
      }
      if (isJsonParseError(error)) throw error;
      if (error instanceof Error && error.message.startsWith('Invalid persisted')) throw error;
      throw new Error('JSON store read failed');
    }
  }

  public write(next: T): void {
    const value = this.validator(clone(next));
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('JSON store cannot serialize value');
    const directory = dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.filePath);
    } catch (error) {
      rmSync(temporary, { force: true });
      if (error instanceof TypeError) throw error;
      throw new Error('JSON store write failed');
    }
  }

  public invalidate(): void {
    // Reads intentionally hit disk so separate processes can observe updates.
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError && /JSON|Unexpected token/.test(error.message);
}
