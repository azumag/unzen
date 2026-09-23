import {
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertEvidenceOutputPathIdentity,
  cleanupReservedEvidenceOutput,
  reserveEvidenceOutput,
} from '../tools/capture_endpoint_embedding_webgpu_runtime.mjs';

describe('endpoint post-stage RSS evidence output reservation', () => {
  it('rejects a pre-existing destination instead of overwriting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-poststage-rss-output-existing-'));
    const outputPath = join(dir, 'evidence.json');
    writeFileSync(outputPath, 'existing\n');
    try {
      expect(() => reserveEvidenceOutput(outputPath)).toThrow();
      expect(readFileSync(outputPath, 'utf8')).toBe('existing\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects pathname replacement and leaves the replacement untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-poststage-rss-output-replaced-'));
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

  it('removes only an unchanged failed reservation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-poststage-rss-output-cleanup-'));
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

  it('reserves before profile/browser side effects and commits through the reserved descriptor', () => {
    const source = readFileSync(
      new URL('../tools/capture_endpoint_poststage_webgpu_process_rss.mjs', import.meta.url),
      'utf8',
    );
    const runStart = source.indexOf('async function runCapture({');
    expect(runStart).toBeGreaterThanOrEqual(0);
    const runSource = source.slice(runStart);

    const reserveIndex = runSource.indexOf('outputFd = reserveEvidenceOutput(outputPath);');
    const profileIndex = runSource.indexOf("profileDir = mkdtempSync(join(tmpdir(), 'unzen-endpoint-poststage-rss-'));\n");
    const serverIndex = runSource.indexOf('server = spawn(process.execPath, [HARNESS_SERVER]');
    const descriptorWriteIndex = runSource.indexOf('writeFileSync(outputFd,');
    const syncIndex = runSource.indexOf('fsyncSync(outputFd);');
    const identityIndex = runSource.indexOf('assertEvidenceOutputPathIdentity(outputFd, outputPath);');
    const commitIndex = runSource.indexOf('outputCommitted = true;');
    const cleanupIndex = runSource.indexOf('cleanupReservedEvidenceOutput(outputFd, outputPath, outputCommitted);');

    for (const index of [
      reserveIndex,
      profileIndex,
      serverIndex,
      descriptorWriteIndex,
      syncIndex,
      identityIndex,
      commitIndex,
      cleanupIndex,
    ]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(reserveIndex).toBeLessThan(profileIndex);
    expect(reserveIndex).toBeLessThan(serverIndex);
    expect(descriptorWriteIndex).toBeLessThan(syncIndex);
    expect(syncIndex).toBeLessThan(identityIndex);
    expect(identityIndex).toBeLessThan(commitIndex);
    expect(commitIndex).toBeLessThan(cleanupIndex);
    expect(runSource).not.toContain('writeFileSync(outputPath,');
  });
});
