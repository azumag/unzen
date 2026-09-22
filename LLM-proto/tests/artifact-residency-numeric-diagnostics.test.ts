import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import { workerId } from '../src/types.js';

function makeArtifacts(): SegmentArtifact[] {
  return [100, 200].map((byteSize, index) => ({
    index,
    layerStart: index * 4,
    layerEnd: index * 4 + 3,
    byteSize,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    contentType: 'application/onnx',
    artifactLocator: `https://cdn.unzen.local/models/test/segment-${index}.onnx`,
    estimatedMemoryMB: 512 + index * 128,
    memoryBasis: 'measured',
    measurementConditions: 'test fixture',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  }));
}

function hostileValue(counter: { count: number }): object {
  const fail = () => {
    counter.count += 1;
    throw new Error('caller coercion hook must not run');
  };
  return {
    [Symbol.toPrimitive]: fail,
    valueOf: fail,
    toString: fail,
  };
}

function hostileFunction(counter: { count: number }): Function {
  const value = function hostileNumericFunction(): void {};
  const fail = () => {
    counter.count += 1;
    throw new Error('caller coercion hook must not run');
  };
  Object.defineProperties(value, {
    [Symbol.toPrimitive]: { value: fail },
    valueOf: { value: fail },
    toString: { value: fail },
  });
  return value;
}

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

describe('ArtifactResidencyLedger numeric diagnostics runtime boundary', () => {
  it('does not coerce hostile object or function segment indexes', () => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());
    const objectCoercions = { count: 0 };
    const functionCoercions = { count: 0 };

    expect(() => ledger.getArtifact(
      hostileValue(objectCoercions) as unknown as number,
    )).toThrow('unknown segment unknown');
    expect(() => ledger.getArtifact(
      hostileFunction(functionCoercions) as unknown as number,
    )).toThrow('unknown segment unknown');

    expect(objectCoercions.count).toBe(0);
    expect(functionCoercions.count).toBe(0);
  });

  it('keeps Symbol and revoked Proxy lookup diagnostics stable', () => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());

    expect(() => ledger.getArtifact(Symbol('missing') as unknown as number))
      .toThrow('unknown segment Symbol(missing)');
    expect(() => ledger.getArtifact(revokedProxy() as unknown as number))
      .toThrow('unknown segment unknown');
  });

  it('validates a hostile range before residency mutation without coercion', () => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());
    const worker = workerId('browser-a');
    ledger.markResident(worker, 0);
    const before = ledger.snapshot(worker);
    const coercions = { count: 0 };

    expect(() => ledger.markResidentRange(
      worker,
      hostileValue(coercions) as unknown as number,
      1,
    )).toThrow('invalid segment range unknown..1; expected 0..1');

    expect(coercions.count).toBe(0);
    expect(ledger.snapshot(worker)).toEqual(before);
  });

  it('keeps range diagnostics stable for Symbol, revoked Proxy, and primitives', () => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());
    const worker = workerId('browser-b');

    expect(() => ledger.artifactBytes(-1, 1))
      .toThrow('invalid segment range -1..1; expected 0..1');
    expect(() => ledger.missingArtifacts(
      worker,
      Symbol('start') as unknown as number,
      1,
    )).toThrow('invalid segment range Symbol(start)..1; expected 0..1');
    expect(() => ledger.residentArtifactBytes(
      worker,
      0,
      revokedProxy() as unknown as number,
    )).toThrow('invalid segment range 0..unknown; expected 0..1');
  });
});
