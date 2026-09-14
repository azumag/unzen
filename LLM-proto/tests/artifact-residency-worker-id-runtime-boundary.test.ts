import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import { workerId, type WorkerId } from '../src/types.js';

function makeArtifacts(): SegmentArtifact[] {
  return [0, 1].map((index) => ({
    index,
    layerStart: index * 4,
    layerEnd: index * 4 + 3,
    byteSize: 100 + index * 100,
    sha256: String(index + 1).repeat(64),
    contentType: 'application/onnx',
    artifactLocator: `https://cdn.unzen.local/models/test/segment-${index}.onnx`,
    estimatedMemoryMB: 512,
    memoryBasis: 'measured',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  }));
}

const malformedWorkerIds: unknown[] = ['', '   ', 42, Symbol('worker')];

describe('ArtifactResidencyLedger worker-id runtime boundary', () => {
  it.each(malformedWorkerIds)(
    'rejects malformed worker identity %s before synchronize mutation',
    (rawWorker) => {
      const ledger = new ArtifactResidencyLedger(makeArtifacts());
      const validWorker = workerId('worker-valid');
      ledger.synchronizeWorker(validWorker, [0]);

      expect(() => ledger.synchronizeWorker(
        rawWorker as WorkerId,
        [1],
      )).toThrow(/workerId must be a non-empty string/);
      expect(ledger.snapshot(validWorker).residentSegmentIndexes).toEqual([0]);
    },
  );

  it.each([
    ['markResident', (ledger: ArtifactResidencyLedger, worker: WorkerId) => ledger.markResident(worker, 1)],
    ['markResidentRange', (ledger: ArtifactResidencyLedger, worker: WorkerId) => ledger.markResidentRange(worker, 0, 1)],
    ['markEvicted', (ledger: ArtifactResidencyLedger, worker: WorkerId) => ledger.markEvicted(worker, 0)],
    ['clearWorker', (ledger: ArtifactResidencyLedger, worker: WorkerId) => ledger.clearWorker(worker)],
  ] as const)(
    'rejects malformed worker ids in %s without changing valid residency',
    (_name, operation) => {
      const ledger = new ArtifactResidencyLedger(makeArtifacts());
      const validWorker = workerId('worker-valid');
      ledger.synchronizeWorker(validWorker, [0]);

      expect(() => operation(ledger, '   ' as WorkerId))
        .toThrow(/workerId must be a non-empty string/);
      expect(ledger.snapshot(validWorker).residentSegmentIndexes).toEqual([0]);
    },
  );

  it.each([
    ['isResident', (ledger: ArtifactResidencyLedger, worker: WorkerId) => ledger.isResident(worker, 0)],
    ['residentPrefixLength', (ledger: ArtifactResidencyLedger, worker: WorkerId) => ledger.residentPrefixLength(worker, 0)],
    ['residentArtifactBytes', (ledger: ArtifactResidencyLedger, worker: WorkerId) => ledger.residentArtifactBytes(worker)],
    ['missingArtifacts', (ledger: ArtifactResidencyLedger, worker: WorkerId) => ledger.missingArtifacts(worker, 0, 1)],
    ['missingArtifactBytes', (ledger: ArtifactResidencyLedger, worker: WorkerId) => ledger.missingArtifactBytes(worker, 0, 1)],
    ['snapshot', (ledger: ArtifactResidencyLedger, worker: WorkerId) => ledger.snapshot(worker)],
  ] as const)(
    'rejects malformed worker ids in %s queries',
    (_name, operation) => {
      const ledger = new ArtifactResidencyLedger(makeArtifacts());
      expect(() => operation(ledger, Symbol('worker') as unknown as WorkerId))
        .toThrow(/workerId must be a non-empty string/);
    },
  );

  it('keeps valid worker identity and residency semantics unchanged', () => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());
    const worker = workerId('worker-valid');

    ledger.markResidentRange(worker, 0, 1);
    expect(ledger.snapshot(worker)).toMatchObject({
      workerId: worker,
      residentSegmentIndexes: [0, 1],
      residentArtifactBytes: 300,
    });
    expect(ledger.residentPrefixLength(worker, 0)).toBe(2);
    expect(ledger.residentArtifactBytes(worker)).toBe(300);
    expect(ledger.missingArtifactBytes(worker, 0, 1)).toBe(0);

    expect(ledger.markEvicted(worker, 0)).toBe(true);
    expect(ledger.isResident(worker, 0)).toBe(false);
    expect(ledger.clearWorker(worker)).toBe(true);
    expect(ledger.snapshot(worker).residentSegmentIndexes).toEqual([]);
  });
});
