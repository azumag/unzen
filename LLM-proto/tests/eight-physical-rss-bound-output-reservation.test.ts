import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('8-physical RSS bound output reservation', () => {
  it('binds normal-completion raw and sidecar outputs to the shared reservation helper', () => {
    const text = source('../tools/capture_endpoint_embedding_eight_physical_webgpu_process_rss_bound.mjs');

    expect(text).toContain("from './evidence_output_reservation.mjs';");
    expect(text).not.toContain('function reserveExclusiveOutput(');
    expect(text).not.toContain("openSync(outputPath, 'wx'");

    const reserveProcess = text.indexOf('processFd = reserveEvidenceOutput(config.processRssOutputPath);');
    const reserveBound = text.indexOf('boundFd = reserveEvidenceOutput(config.boundOutputPath);');
    const spawn = text.indexOf('const result = spawnSync(process.execPath');
    expect(reserveProcess).toBeGreaterThanOrEqual(0);
    expect(reserveBound).toBeGreaterThan(reserveProcess);
    expect(spawn).toBeGreaterThan(reserveBound);

    const writeProcess = text.indexOf('writeCommittedJson(processFd, evidence);');
    const writeBound = text.indexOf('writeCommittedJson(boundFd, bound);');
    const assertProcess = text.indexOf(
      'assertEvidenceOutputPathIdentity(processFd, config.processRssOutputPath);',
    );
    const assertBound = text.indexOf(
      'assertEvidenceOutputPathIdentity(boundFd, config.boundOutputPath);',
    );
    const committed = text.indexOf('outputsCommitted = true;');
    expect(writeProcess).toBeGreaterThan(spawn);
    expect(writeBound).toBeGreaterThan(writeProcess);
    expect(assertProcess).toBeGreaterThan(writeBound);
    expect(assertBound).toBeGreaterThan(assertProcess);
    expect(committed).toBeGreaterThan(assertBound);

    const cleanupProcess = text.indexOf(
      'cleanupReservedEvidenceOutput(processFd, config.processRssOutputPath, outputsCommitted);',
    );
    const closeProcess = text.indexOf('closeSync(processFd);', cleanupProcess);
    const cleanupBound = text.indexOf(
      'cleanupReservedEvidenceOutput(boundFd, config.boundOutputPath, outputsCommitted);',
    );
    const closeBound = text.indexOf('closeSync(boundFd);', cleanupBound);
    expect(cleanupProcess).toBeGreaterThan(committed);
    expect(closeProcess).toBeGreaterThan(cleanupProcess);
    expect(cleanupBound).toBeGreaterThan(closeProcess);
    expect(closeBound).toBeGreaterThan(cleanupBound);
  });

  it('fsyncs and identity-checks the cancellation sidecar before commit', () => {
    const text = source('../tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs');

    expect(text).toContain("from './evidence_output_reservation.mjs';");
    expect(text).not.toContain('function reserveExclusiveOutput(');
    expect(text).not.toContain("openSync(outputPath, 'wx'");

    const reserve = text.indexOf('const boundFd = reserveEvidenceOutput(config.boundOutputPath);');
    const spawn = text.indexOf('const result = spawnSync(process.execPath');
    const write = text.indexOf("writeFileSync(boundFd, `${JSON.stringify(bound, null, 2)}\\n`, 'utf8');");
    const fsync = text.indexOf('fsyncSync(boundFd);');
    const assertIdentity = text.indexOf(
      'assertEvidenceOutputPathIdentity(boundFd, config.boundOutputPath);',
    );
    const committed = text.indexOf('boundOutputCommitted = true;');
    expect(reserve).toBeGreaterThanOrEqual(0);
    expect(spawn).toBeGreaterThan(reserve);
    expect(write).toBeGreaterThan(spawn);
    expect(fsync).toBeGreaterThan(write);
    expect(assertIdentity).toBeGreaterThan(fsync);
    expect(committed).toBeGreaterThan(assertIdentity);

    const cleanup = text.indexOf(
      'cleanupReservedEvidenceOutput(boundFd, config.boundOutputPath, boundOutputCommitted);',
    );
    const close = text.indexOf('closeSync(boundFd);', cleanup);
    expect(cleanup).toBeGreaterThan(committed);
    expect(close).toBeGreaterThan(cleanup);
  });
});
