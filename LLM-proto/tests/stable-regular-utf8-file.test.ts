import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readStableRegularUtf8File,
  readStableRegularUtf8FileWithReader,
} from '../tools/read_stable_regular_utf8_file.mjs';

describe('stable regular UTF-8 file reader', () => {
  it('reads a stable regular file from the opened snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-stable-file-test-'));
    const path = join(dir, 'evidence.json');
    try {
      writeFileSync(path, '{"status":"pass"}\n');
      expect(readStableRegularUtf8File(path, 'test evidence')).toEqual({
        resolvedPath: path,
        text: '{"status":"pass"}\n',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a file exactly at the configured byte limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-stable-file-test-'));
    const path = join(dir, 'evidence.json');
    try {
      writeFileSync(path, '12345678');
      expect(readStableRegularUtf8File(path, 'test evidence', 8)).toEqual({
        resolvedPath: path,
        text: '12345678',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed before returning an oversized evidence file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-stable-file-test-'));
    const path = join(dir, 'evidence.json');
    try {
      writeFileSync(path, '123456789');
      expect(() => readStableRegularUtf8File(path, 'test evidence', 8)).toThrow(
        'test evidence exceeds 8 byte limit',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid byte limits', () => {
    expect(() => readStableRegularUtf8File('/unused', 'test evidence', 0)).toThrow(
      'stable UTF-8 file maximumBytes must be a positive safe integer',
    );
  });

  it('fails closed when the evidence pathname is replaced during the read window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-stable-file-test-'));
    const path = join(dir, 'evidence.json');
    const movedPath = join(dir, 'evidence-moved.json');
    try {
      writeFileSync(path, '{"status":"pass"}\n');
      expect(() => readStableRegularUtf8FileWithReader(path, 'test evidence', (fd) => {
        const text = readFileSync(fd, 'utf8');
        renameSync(path, movedPath);
        writeFileSync(path, '{"status":"replacement"}\n');
        return text;
      })).toThrow(/test evidence (changed while reading|path identity changed while reading)/);

      expect(readFileSync(path, 'utf8')).toBe('{"status":"replacement"}\n');
      expect(readFileSync(movedPath, 'utf8')).toBe('{"status":"pass"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects directories instead of treating them as evidence files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-stable-file-test-'));
    try {
      expect(() => readStableRegularUtf8File(dir, 'test evidence')).toThrow(
        'test evidence must be a regular file',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const symlinkTest = process.platform === 'win32' ? it.skip : it;
  symlinkTest('rejects a final symlink instead of following it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-stable-file-test-'));
    const targetPath = join(dir, 'target.json');
    const linkPath = join(dir, 'evidence.json');
    try {
      writeFileSync(targetPath, '{"status":"pass"}\n');
      symlinkSync(targetPath, linkPath);
      expect(() => readStableRegularUtf8File(linkPath, 'test evidence')).toThrow(
        'test evidence must not be a symlink',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
