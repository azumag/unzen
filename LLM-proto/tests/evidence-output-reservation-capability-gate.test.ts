import { closeSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Simulates a runtime that does not expose the primitives the generation-bound removal needs.
// The candidate 4 fallback must then mutate nothing and report false instead of falling back to a
// pathname unlink.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, renameSync: undefined, unlinkSync: undefined };
});

import {
  cleanupReservedEvidenceOutput,
  evidenceOutputGenerationBoundCleanupAvailable,
  reserveEvidenceOutput,
} from '../tools/evidence_output_reservation.mjs';

describe('reserved evidence output cleanup capability gate', () => {
  it('fails closed and leaves the failed reservation artifact in place', () => {
    expect(evidenceOutputGenerationBoundCleanupAvailable()).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-capability-'));
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
});
