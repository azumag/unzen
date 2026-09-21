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
    evidenceKind: 'root-discriminant-snapshot',
    evidenceLevel: 'synthetic-fixture',
    readinessStatus: 'contract-tested',
    producer: { name: 'vitest', version: '4.1.7' },
    runId: 'root-discriminant-snapshot',
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

describe('validateEvidenceEnvelope root discriminant snapshot', () => {
  it('binds evidence-level classification to the first root read', async () => {
    const envelope = syntheticEnvelope();
    let reads = 0;
    Object.defineProperty(envelope, 'evidenceLevel', {
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? 'synthetic-fixture' : 'captured-and-verified';
      },
    });

    const result = await validateEvidenceEnvelope(envelope, { now: NOW });

    expect(reads).toBe(1);
    expect(result.status).toBe('valid');
    expect(result.claimedEvidenceLevel).toBe('synthetic-fixture');
    expect(result.effectiveEvidenceLevel).toBe('synthetic-fixture');
  });

  it('fails closed when the evidence-level getter throws', async () => {
    const envelope = syntheticEnvelope();
    let reads = 0;
    Object.defineProperty(envelope, 'evidenceLevel', {
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
      code: 'invalid-evidence-level',
      path: '$.evidenceLevel',
      message: 'invalid evidence level',
    });
  });

  it('binds readiness validation to the first root read', async () => {
    const envelope = syntheticEnvelope();
    let reads = 0;
    Object.defineProperty(envelope, 'readinessStatus', {
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? 'contract-tested' : 'production-approved';
      },
    });

    const result = await validateEvidenceEnvelope(envelope, { now: NOW });

    expect(reads).toBe(1);
    expect(result.status).toBe('valid');
    expect(result.claimedReadinessStatus).toBe('contract-tested');
    expect(result.effectiveReadinessStatus).toBe('contract-tested');
  });

  it('fails closed when the readiness-status getter throws', async () => {
    const envelope = syntheticEnvelope();
    let reads = 0;
    Object.defineProperty(envelope, 'readinessStatus', {
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
      code: 'invalid-readiness-status',
      path: '$.readinessStatus',
      message: 'invalid readiness status',
    });
  });

  it('uses one schema-version read for required and support checks', async () => {
    const envelope = syntheticEnvelope();
    let reads = 0;
    Object.defineProperty(envelope, 'schemaVersion', {
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? EVIDENCE_SCHEMA_VERSION : '2.0.0';
      },
    });

    const result = await validateEvidenceEnvelope(envelope, { now: NOW });

    expect(reads).toBe(1);
    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
  });

  it('fails closed when the schema-version getter throws', async () => {
    const envelope = syntheticEnvelope();
    let reads = 0;
    Object.defineProperty(envelope, 'schemaVersion', {
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
      path: '$.schemaVersion',
      message: 'schemaVersion must be a non-empty string',
    });
  });
});
