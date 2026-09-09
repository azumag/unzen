import { closeSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertEvidenceOutputPathIdentity,
  cleanupReservedEvidenceOutput,
  reserveEvidenceOutput,
} from '../tools/capture_endpoint_embedding_webgpu_runtime.mjs';

describe('endpoint embedding WebGPU evidence output reservation', () => {
  it('accepts the originally reserved path identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-endpoint-output-identity-test-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      expect(() => assertEvidenceOutputPathIdentity(fd, outputPath)).not.toThrow();
      expect(cleanupReservedEvidenceOutput(fd, outputPath, true)).toBe(false);
      expect(existsSync(outputPath)).toBe(true);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the reserved pathname is replaced and leaves the replacement untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-endpoint-output-identity-test-'));
    const outputPath = join(dir, 'evidence.json');
    const movedPath = join(dir, 'reserved-moved.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      renameSync(outputPath, movedPath);
      writeFileSync(outputPath, 'replacement\n');

      expect(() => assertEvidenceOutputPathIdentity(fd, outputPath)).toThrow(
        'evidence output path identity changed after reservation',
      );
      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect(readFileSync(outputPath, 'utf8')).toBe('replacement\n');
      expect(existsSync(movedPath)).toBe(true);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes a failed reservation only while the pathname still identifies the reserved file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-endpoint-output-identity-test-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(true);
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
