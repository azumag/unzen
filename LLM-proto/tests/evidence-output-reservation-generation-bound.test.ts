import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanupReservedEvidenceOutput,
  evidenceOutputGenerationBoundCleanupAvailable,
  reserveEvidenceOutput,
} from '../tools/evidence_output_reservation.mjs';

describe('generation-bound evidence output cleanup policy (unzen#1494)', () => {
  it('reports generation-bound cleanup as unavailable even with ordinary Node fs primitives', () => {
    expect(typeof renameSync).toBe('function');
    expect(typeof unlinkSync).toBe('function');
    expect(evidenceOutputGenerationBoundCleanupAvailable()).toBe(false);
  });

  it('retains an unchanged failed reservation without reporting removal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-unchanged-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect(existsSync(outputPath)).toBe(true);
      expect(readFileSync(outputPath, 'utf8')).toBe('');
      expect(readdirSync(dir)).toEqual(['evidence.json']);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never removes committed evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-committed-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      writeFileSync(fd, 'committed\n');
      expect(cleanupReservedEvidenceOutput(fd, outputPath, true)).toBe(false);
      expect(readFileSync(outputPath, 'utf8')).toBe('committed\n');
      expect(readdirSync(dir)).toEqual(['evidence.json']);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a pathname that already holds a replacement untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-replaced-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      unlinkSync(outputPath);
      writeFileSync(outputPath, 'replacement\n');
      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect(readFileSync(outputPath, 'utf8')).toBe('replacement\n');
      expect(readdirSync(dir)).toEqual(['evidence.json']);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports false when the reserved pathname is already gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-missing-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      unlinkSync(outputPath);
      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a directory that replaced the reserved pathname', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-directory-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      unlinkSync(outputPath);
      mkdirSync(outputPath);
      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect(readdirSync(dir)).toEqual(['evidence.json']);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a symlink that replaced the reserved pathname', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-symlink-'));
    const outputPath = join(dir, 'evidence.json');
    const targetPath = join(dir, 'target.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      unlinkSync(outputPath);
      writeFileSync(targetPath, 'target\n');
      symlinkSync(targetPath, outputPath);
      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect(readFileSync(targetPath, 'utf8')).toBe('target\n');
      expect(readdirSync(dir).sort()).toEqual(['evidence.json', 'target.json']);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: repeated cleanup retains the same failed reservation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-idempotent-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect(readFileSync(outputPath, 'utf8')).toBe('');
      expect(readdirSync(dir)).toEqual(['evidence.json']);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports false without mutating anything when the reserved descriptor is already closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-closed-fd-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      closeSync(fd);
      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect(readFileSync(outputPath, 'utf8')).toBe('');
      expect(readdirSync(dir)).toEqual(['evidence.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires a different name or manual removal to retry a failed reservation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-retry-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    let retryFd: number | undefined;
    let alternateFd: number | undefined;
    try {
      writeFileSync(fd, 'partial failed capture\n');
      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect(() => reserveEvidenceOutput(outputPath)).toThrow(/EEXIST/);
      expect(readFileSync(outputPath, 'utf8')).toBe('partial failed capture\n');
      alternateFd = reserveEvidenceOutput(join(dir, 'retry.json'));
      // Explicit operator removal is simulated only inside this disposable fixture directory.
      unlinkSync(outputPath);
      retryFd = reserveEvidenceOutput(outputPath);
      expect(readFileSync(outputPath, 'utf8')).toBe('');
    } finally {
      closeSync(fd);
      if (alternateFd !== undefined) closeSync(alternateFd);
      if (retryFd !== undefined) closeSync(retryFd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a single shared cleanup policy across every host-side capture tool', () => {
    const toolsDir = new URL('../tools/', import.meta.url);
    const captureTools = readdirSync(toolsDir).filter((name) => /^capture_endpoint.*\.mjs$/.test(name));
    expect(captureTools.length).toBeGreaterThanOrEqual(6);

    for (const name of captureTools) {
      const source = readFileSync(new URL(name, toolsDir), 'utf8');
      expect(source, `${name} must use the shared reservation helper`).toContain("from './evidence_output_reservation.mjs';");
      expect(source, `${name} must route cleanup through the shared policy`).toContain('cleanupReservedEvidenceOutput(');
      expect(source, `${name} must not remove the reservation itself`).not.toContain('unlinkSync');
      expect(source, `${name} must not move the reservation itself`).not.toContain('renameSync');
      // Any recursive/forced removal call must not be aimed at the reserved output pathname.
      expect(source, `${name} must not rm the reservation`).not.toMatch(/rm\w*\([^)]*[Oo]utputPath/);
    }
  });
});
