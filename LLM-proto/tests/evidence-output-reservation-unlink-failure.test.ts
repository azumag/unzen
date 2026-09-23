import { closeSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const unlinkSyncMock = vi.hoisted(() => vi.fn(() => {
  const error = new Error('permission denied') as NodeJS.ErrnoException;
  error.code = 'EACCES';
  throw error;
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    unlinkSync: unlinkSyncMock,
  };
});

import {
  cleanupReservedEvidenceOutput,
  reserveEvidenceOutput,
} from '../tools/evidence_output_reservation.mjs';

describe('shared evidence output reservation cleanup result', () => {
  it('returns false and contains the error when unlink fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-output-cleanup-failure-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect(unlinkSyncMock).toHaveBeenCalledWith(outputPath);
      expect(existsSync(outputPath)).toBe(true);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
