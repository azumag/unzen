import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

function source(relativePath: string): string {
  return readFileSync(resolve(HERE, relativePath), 'utf8');
}

function expectDescriptorBoundCommit(text: string, runStart: number): void {
  const reserve = text.indexOf(
    'outputFd = reserveEvidenceOutput(config.outputPath);',
    runStart,
  );
  const write = text.indexOf('writeFileSync(outputFd,', reserve);
  const fsync = text.indexOf('fsyncSync(outputFd);', write);
  const identity = text.indexOf(
    'assertEvidenceOutputPathIdentity(outputFd, config.outputPath);',
    fsync,
  );
  const commit = text.indexOf('outputCommitted = true;', identity);
  const cleanup = text.indexOf(
    'cleanupReservedEvidenceOutput(outputFd, config.outputPath, outputCommitted);',
    commit,
  );
  const close = text.indexOf('closeSync(outputFd);', cleanup);

  expect(reserve).toBeGreaterThan(runStart);
  expect(write).toBeGreaterThan(reserve);
  expect(fsync).toBeGreaterThan(write);
  expect(identity).toBeGreaterThan(fsync);
  expect(commit).toBeGreaterThan(identity);
  expect(cleanup).toBeGreaterThan(commit);
  expect(close).toBeGreaterThan(cleanup);
  expect(text.slice(runStart)).not.toContain('writeFileSync(config.outputPath');
}

describe('direct 8-physical RSS output reservation', () => {
  it('reserves normal-completion output before capture side effects', () => {
    const text = source(
      '../tools/capture_endpoint_embedding_eight_physical_webgpu_process_rss.mjs',
    );
    expect(text).toContain("from './evidence_output_reservation.mjs'");

    const runStart = text.indexOf('async function runCapture(config)');
    const reserve = text.indexOf(
      'outputFd = reserveEvidenceOutput(config.outputPath);',
      runStart,
    );
    const profile = text.indexOf('profileDir = mkdtempSync(', runStart);
    const port = text.indexOf(
      "await assertPortAvailable(config.serverPort, 'harness server');",
      runStart,
    );
    const spawn = text.indexOf(
      'server = spawn(process.execPath, [HARNESS_SERVER]',
      runStart,
    );

    expect(runStart).toBeGreaterThanOrEqual(0);
    expect(reserve).toBeGreaterThan(runStart);
    expect(profile).toBeGreaterThan(reserve);
    expect(port).toBeGreaterThan(reserve);
    expect(spawn).toBeGreaterThan(reserve);
    expectDescriptorBoundCommit(text, runStart);
  });

  it('keeps cancellation input-alias preflight ahead of reservation', () => {
    const text = source(
      '../tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs',
    );
    expect(text).toContain("from './evidence_output_reservation.mjs'");

    const runStart = text.indexOf('async function runCapture(config)');
    const preflight = text.indexOf(
      'await preflightCancellationRssCapture(config);',
      runStart,
    );
    const reserve = text.indexOf(
      'outputFd = reserveEvidenceOutput(config.outputPath);',
      runStart,
    );
    const profile = text.indexOf('profileDir = mkdtempSync(', runStart);
    const port = text.indexOf(
      "await assertPortAvailable(config.serverPort, 'harness server');",
      runStart,
    );
    const spawn = text.indexOf(
      'server = spawn(process.execPath, [HARNESS_SERVER]',
      runStart,
    );

    expect(preflight).toBeGreaterThan(runStart);
    expect(reserve).toBeGreaterThan(preflight);
    expect(profile).toBeGreaterThan(reserve);
    expect(port).toBeGreaterThan(reserve);
    expect(spawn).toBeGreaterThan(reserve);
    expectDescriptorBoundCommit(text, runStart);
  });
});
