import { closeSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Records every rename/unlink the helper performs, and can retarget the reserved pathname at the
// exact boundary the policy is about: the moment the helper commits to a removal, after it has
// already validated the pathname identity.
const fsHarness = vi.hoisted(() => ({
  renameCalls: [] as Array<[string, string]>,
  unlinkCalls: [] as string[],
  injectReplacementAtRename: false,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      fsHarness.renameCalls.push([from, to]);
      if (fsHarness.injectReplacementAtRename) {
        fsHarness.injectReplacementAtRename = false;
        // The reserved pathname is replaced in the identity-check-to-removal window.
        actual.unlinkSync(from);
        actual.writeFileSync(from, 'replacement\n');
      }
      return actual.renameSync(from, to);
    },
    unlinkSync: (path: string) => {
      fsHarness.unlinkCalls.push(path);
      return actual.unlinkSync(path);
    },
  };
});

import {
  cleanupReservedEvidenceOutput,
  reserveEvidenceOutput,
} from '../tools/evidence_output_reservation.mjs';

const QUARANTINE_MARKER = '.unzen-reservation-cleanup-';

describe('reserved evidence output cleanup removal boundary', () => {
  beforeEach(() => {
    fsHarness.renameCalls = [];
    fsHarness.unlinkCalls = [];
    fsHarness.injectReplacementAtRename = false;
  });

  it('binds the removal to the reserved inode through a private quarantine name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-boundary-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(true);
      expect(fsHarness.renameCalls).toHaveLength(1);
      expect(fsHarness.renameCalls[0][0]).toBe(outputPath);
      expect(fsHarness.renameCalls[0][1]).toContain(QUARANTINE_MARKER);
      expect(fsHarness.unlinkCalls).toHaveLength(1);
      expect(fsHarness.unlinkCalls[0]).toContain(QUARANTINE_MARKER);
      expect(fsHarness.unlinkCalls[0]).not.toBe(outputPath);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves a replacement injected between the pathname identity check and the removal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-boundary-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      fsHarness.injectReplacementAtRename = true;

      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect(readFileSync(outputPath, 'utf8')).toBe('replacement\n');
      // The replacement is never the delete target: nothing was unlinked at all.
      expect(fsHarness.unlinkCalls).toEqual([]);
      expect(readdirSync(dir)).toEqual(['evidence.json']);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('performs no filesystem mutation for committed evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-boundary-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      writeFileSync(fd, 'committed\n');
      expect(cleanupReservedEvidenceOutput(fd, outputPath, true)).toBe(false);
      expect(fsHarness.renameCalls).toEqual([]);
      expect(fsHarness.unlinkCalls).toEqual([]);
      expect(readFileSync(outputPath, 'utf8')).toBe('committed\n');
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('performs no filesystem mutation once the pathname is already retargeted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-boundary-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      unlinkSync(outputPath);
      writeFileSync(outputPath, 'replacement\n');
      fsHarness.renameCalls = [];
      fsHarness.unlinkCalls = [];

      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect(fsHarness.renameCalls).toEqual([]);
      expect(fsHarness.unlinkCalls).toEqual([]);
      expect(readFileSync(outputPath, 'utf8')).toBe('replacement\n');
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
