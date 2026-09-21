import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_SCHEMA_VERSION,
  validateEvidenceEnvelope,
  type SyntheticEvidenceEnvelope,
} from '../src/evidence.js';

const NOW = '2026-07-10T14:00:00.000Z';

function syntheticEnvelope(): SyntheticEvidenceEnvelope<{ status: string }> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: 'base-field-runtime-boundary',
    evidenceLevel: 'synthetic-fixture',
    readinessStatus: 'contract-tested',
    producer: { name: 'vitest', version: '4.1.7' },
    runId: 'base-field-runtime-boundary-run',
    capturedAt: '2026-07-10T13:00:00.000Z',
    environment: {
      runtime: 'node',
      runtimeVersion: '24',
      executionSurface: 'test-runner',
    },
    redaction: { applied: true, policyVersion: 'test-v1' },
    payload: { status: 'pass' },
  };
}

function hostileThrownValue(): object {
  return new Proxy({}, {
    getPrototypeOf() {
      throw new Error('thrown value must not be inspected');
    },
    get() {
      throw new Error('thrown value must not be stringified');
    },
  });
}

describe('validateEvidenceEnvelope base-field runtime boundary', () => {
  it.each([
    ['evidenceKind', '$.evidenceKind', 'evidenceKind must be a non-empty string'],
    ['runId', '$.runId', 'runId must be a non-empty string'],
  ] as const)('fails closed when the %s getter throws', async (field, path, message) => {
    const envelope = syntheticEnvelope();
    let reads = 0;
    Object.defineProperty(envelope, field, {
      configurable: true,
      get() {
        reads += 1;
        throw hostileThrownValue();
      },
    });

    const result = await validateEvidenceEnvelope(envelope, { now: NOW });

    expect(reads).toBe(1);
    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual({
      code: 'invalid-envelope',
      path,
      message,
    });
  });

  it('fails closed when the capturedAt getter throws', async () => {
    const envelope = syntheticEnvelope();
    let reads = 0;
    Object.defineProperty(envelope, 'capturedAt', {
      configurable: true,
      get() {
        reads += 1;
        throw hostileThrownValue();
      },
    });

    const result = await validateEvidenceEnvelope(envelope, { now: NOW });

    expect(reads).toBe(1);
    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual({
      code: 'invalid-timestamp',
      path: '$.capturedAt',
      message: 'capturedAt must be a valid timestamp',
    });
  });

  it('fails closed when required payload presence cannot be inspected', async () => {
    const target = syntheticEnvelope();
    let payloadDescriptorReads = 0;
    const envelope = new Proxy(target, {
      getOwnPropertyDescriptor(currentTarget, property) {
        if (property === 'payload') {
          payloadDescriptorReads += 1;
          throw hostileThrownValue();
        }
        return Reflect.getOwnPropertyDescriptor(currentTarget, property);
      },
    });

    const result = await validateEvidenceEnvelope(envelope, { now: NOW });

    expect(payloadDescriptorReads).toBe(1);
    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual({
      code: 'invalid-envelope',
      path: '$.payload',
      message: 'payload is required',
    });
  });
});
