import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readStableBoundJsonFile,
} from '../tools/verify_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs';

describe('bound RSS JSON stable reader', () => {
  it('parses valid bounded JSON from a regular file', () => {
    const root = mkdtempSync(join(tmpdir(), 'unzen-bound-json-read-'));
    try {
      const input = join(root, 'input.json');
      writeFileSync(input, '{"ok":true}\n', 'utf8');
      expect(readStableBoundJsonFile(input, 'bound input', { maxBytes: 64 }))
        .toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an initially oversized file before JSON parsing', () => {
    const root = mkdtempSync(join(tmpdir(), 'unzen-bound-json-read-'));
    try {
      const input = join(root, 'input.json');
      writeFileSync(input, '{"padding":"1234567890"}\n', 'utf8');
      expect(() => readStableBoundJsonFile(input, 'bound input', { maxBytes: 8 }))
        .toThrow('bound input size must be 1..8 bytes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps final symlink rejection intact', () => {
    const root = mkdtempSync(join(tmpdir(), 'unzen-bound-json-read-'));
    try {
      const target = join(root, 'target.json');
      const alias = join(root, 'alias.json');
      writeFileSync(target, '{"ok":true}\n', 'utf8');
      symlinkSync(target, alias);
      expect(() => readStableBoundJsonFile(alias, 'bound input'))
        .toThrow('bound input must be a non-symlink regular file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds descriptor reads to the accepted snapshot plus one growth probe', () => {
    const source = readFileSync(
      new URL(
        '../tools/verify_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs',
        import.meta.url,
      ),
      'utf8',
    );
    const start = source.indexOf('export function readStableBoundJsonFile');
    const end = source.indexOf(
      'export function validateBoundCancellationRssEvidence',
      start,
    );
    const reader = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(reader).toContain('const remaining = initialSize + 1 - totalBytes;');
    expect(reader).toContain('readSync(fd, buffer, 0, buffer.length, null)');
    expect(reader).toContain('if (totalBytes !== initialSize)');
    expect(reader).not.toContain('readFileSync(fd)');
  });
});
