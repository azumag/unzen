import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFootprintJsonReport } from '../tools/capture_endpoint_poststage_webgpu_process_rss.mjs';
import { DEFAULT_MAX_STABLE_UTF8_BYTES } from '../tools/read_stable_regular_utf8_file.mjs';

const scratchDirs: string[] = [];

function makeScratchDir() {
  const dir = mkdtempSync(join(tmpdir(), 'unzen-footprint-json-read-test-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe('macOS footprint JSON report read boundary', () => {
  it('reads and parses a valid generated footprint report', () => {
    const reportPath = join(makeScratchDir(), 'footprint.json');
    writeFileSync(reportPath, JSON.stringify({ processes: [], errors: [], warnings: [] }), 'utf8');

    expect(readFootprintJsonReport(reportPath)).toEqual({
      processes: [],
      errors: [],
      warnings: [],
    });
  });

  it('rejects malformed JSON before footprint report consumption', () => {
    const reportPath = join(makeScratchDir(), 'footprint.json');
    writeFileSync(reportPath, '{"processes":[}', 'utf8');

    expect(() => readFootprintJsonReport(reportPath)).toThrow();
  });

  it('rejects reports larger than the shared stable UTF-8 ceiling', () => {
    const reportPath = join(makeScratchDir(), 'footprint.json');
    writeFileSync(reportPath, Buffer.alloc(DEFAULT_MAX_STABLE_UTF8_BYTES + 1, 0x20));

    expect(() => readFootprintJsonReport(reportPath))
      .toThrow(`macOS footprint JSON report exceeds ${DEFAULT_MAX_STABLE_UTF8_BYTES} byte limit`);
  });

  it('rejects invalid UTF-8 before JSON parsing', () => {
    const reportPath = join(makeScratchDir(), 'footprint.json');
    writeFileSync(reportPath, Buffer.from([0x7b, 0xc3, 0x28, 0x7d]));

    expect(() => readFootprintJsonReport(reportPath))
      .toThrow('macOS footprint JSON report must contain valid UTF-8');
  });

  it('rejects a final symlink instead of following it', () => {
    if (process.platform === 'win32') return;
    const dir = makeScratchDir();
    const targetPath = join(dir, 'target.json');
    const reportPath = join(dir, 'footprint.json');
    writeFileSync(targetPath, '{"processes":[]}', 'utf8');
    symlinkSync(targetPath, reportPath);

    expect(() => readFootprintJsonReport(reportPath))
      .toThrow('macOS footprint JSON report must not be a symlink');
  });

  it('keeps process-identity recheck before the stable report read and summary', () => {
    const source = readFileSync(
      new URL('../tools/capture_endpoint_poststage_webgpu_process_rss.mjs', import.meta.url),
      'utf8',
    );
    const footprintStart = source.indexOf('function footprintSnapshot(rootPid)');
    const identityIndex = source.indexOf('if (!sameProcessIdentitySet(before.targetRows, after.targetRows))', footprintStart);
    const readIndex = source.indexOf('const report = readFootprintJsonReport(reportPath);', footprintStart);
    const summarizeIndex = source.indexOf('const summary = summarizeFootprintReport(rootPid, after.psRows, report);', footprintStart);

    expect(footprintStart).toBeGreaterThanOrEqual(0);
    expect(identityIndex).toBeGreaterThan(footprintStart);
    expect(readIndex).toBeGreaterThan(identityIndex);
    expect(summarizeIndex).toBeGreaterThan(readIndex);
    expect(source).not.toContain("readFileSync(reportPath, 'utf8')");
  });
});
