import { closeSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsHarness = vi.hoisted(() => ({
  mutations: [] as string[],
  identityChecks: [] as string[],
  injectAtRename: false,
  injectAfterFinalCheck: false,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    lstatSync: (path: string, options: { bigint: true }) => {
      const checkedGeneration = actual.lstatSync(path, options);
      fsHarness.identityChecks.push(path);
      if (fsHarness.injectAfterFinalCheck && path.includes('.unzen-reservation-cleanup-')) {
        fsHarness.injectAfterFinalCheck = false;
        // Return the reserved inode's final check, but replace the quarantine entry before unlink.
        // This is the exact race rejected by review 5450591171. Only fixture files are touched.
        actual.renameSync(path, `${path}.reserved`);
        actual.writeFileSync(path, 'unrelated final-check replacement\n');
      }
      return checkedGeneration;
    },
    renameSync: (from: string, to: string) => {
      fsHarness.mutations.push('rename');
      if (fsHarness.injectAtRename) {
        fsHarness.injectAtRename = false;
        actual.renameSync(from, `${from}.reserved`);
        actual.writeFileSync(from, 'unrelated pre-rename replacement\n');
      }
      return actual.renameSync(from, to);
    },
    unlinkSync: (path: string) => {
      fsHarness.mutations.push('unlink');
      return actual.unlinkSync(path);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      fsHarness.mutations.push('write');
      return actual.writeFileSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      fsHarness.mutations.push('rm');
      return actual.rmSync(...args);
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      fsHarness.mutations.push('open');
      return actual.openSync(...args);
    },
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      fsHarness.mutations.push('mkdir');
      return actual.mkdirSync(...args);
    },
  };
});

import {
  cleanupReservedEvidenceOutput,
  reserveEvidenceOutput,
} from '../tools/evidence_output_reservation.mjs';

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

function snapshot(dir: string) {
  return actualFs.readdirSync(dir).sort().map((name) => {
    const path = join(dir, name);
    const stat = actualFs.lstatSync(path, { bigint: true });
    return { name, dev: stat.dev, ino: stat.ino, content: actualFs.readFileSync(path, 'utf8') };
  });
}

describe('reserved evidence output cleanup fails before namespace mutation', () => {
  beforeEach(() => {
    fsHarness.mutations = [];
    fsHarness.identityChecks = [];
    fsHarness.injectAtRename = false;
    fsHarness.injectAfterFinalCheck = false;
  });

  it.each(['unchanged', 'before-rename', 'after-final-check', 'committed'])(
    'preserves every file without entering the %s cleanup boundary', (scenario) => {
      const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-boundary-'));
      const outputPath = join(dir, 'evidence.json');
      const fd = reserveEvidenceOutput(outputPath);
      try {
        actualFs.writeFileSync(fd, 'partial or committed capture\n');
        actualFs.writeFileSync(join(dir, 'unrelated.json'), 'unrelated sibling\n');
        actualFs.writeFileSync(join(dir, '.unzen-reservation-cleanup-existing'), 'existing private-name sibling\n');
        const before = snapshot(dir);
        fsHarness.mutations = [];
        fsHarness.injectAtRename = scenario === 'before-rename';
        fsHarness.injectAfterFinalCheck = scenario === 'after-final-check';

        const result = cleanupReservedEvidenceOutput(fd, outputPath, scenario === 'committed');

        expect([...fsHarness.mutations]).toEqual([]);
        expect([...fsHarness.identityChecks]).toEqual([]);
        // Armed replacement hooks must never be reached: cleanup stops before rename or final check.
        expect(fsHarness.injectAtRename).toBe(scenario === 'before-rename');
        expect(fsHarness.injectAfterFinalCheck).toBe(scenario === 'after-final-check');
        expect(result).toBe(false);
        expect(snapshot(dir)).toEqual(before);
      } finally {
        closeSync(fd);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('leaves an already-replaced output and the displaced reservation at their original names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-evidence-cleanup-retargeted-'));
    const outputPath = join(dir, 'evidence.json');
    const fd = reserveEvidenceOutput(outputPath);
    try {
      actualFs.writeFileSync(fd, 'failed reservation\n');
      actualFs.renameSync(outputPath, join(dir, 'reserved-moved.json'));
      actualFs.writeFileSync(outputPath, 'unrelated replacement\n');
      const before = snapshot(dir);
      fsHarness.mutations = [];

      expect(cleanupReservedEvidenceOutput(fd, outputPath, false)).toBe(false);
      expect([...fsHarness.mutations]).toEqual([]);
      expect([...fsHarness.identityChecks]).toEqual([]);
      expect(snapshot(dir)).toEqual(before);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
