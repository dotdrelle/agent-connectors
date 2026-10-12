import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/**
 * Read a JSON file, or `undefined` when it does not exist. A file that exists
 * but does not parse throws: a corrupt token or state file is a repair to
 * announce, not an absence to paper over.
 */
export function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

/**
 * Atomic, owner-only write: a temp file opened `wx` with mode 0600, then a
 * rename. A reader therefore sees the old file or the new one, never half of
 * it — which matters for a rotating refresh token: losing the new one between
 * two writes would lose the session.
 */
export function writeJsonFile(filePath: string, payload: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    // On disk before the rename: a rotated refresh token lost to a crash is a lost session.
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tempPath, { force: true });
  }
}

export function removeFile(filePath: string): void {
  rmSync(filePath, { force: true });
}
