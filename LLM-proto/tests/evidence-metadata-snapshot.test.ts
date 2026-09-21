import { describe, expect, it } from 'vitest';
import { validateEvidenceEnvelope } from '../src/evidence.js';
import {
  createCapturedAndVerifiedEnvelope,
  createSyntheticEnvelope,
  createVerifiedValidationOptions,
} from './evidence-envelope-helpers.js';

describe('validateEvidenceEnvelope metadata snapshots', () => {
  it('reads shared metadata references and primitive fields once across validation stages', async () => {
    const envelope = createCapturedAndVerifiedEnvelope({ status: 'pass' });
    const producer = envelope.producer;
    const environment = envelope.environment;
    const redaction = envelope.redaction;
    const scenario = envelope.scenario;

    const reads = new Map<string, number>();
    const once = <T>(key: string, value: T): (() => T) => () => {
      const count = (reads.get(key) ?? 0) + 1;
      reads.set(key, count);
      if (count > 1) throw new Error(`${key} must not be reread`);
      return value;
    };

    Object.defineProperties(envelope, {
      producer: { configurable: true, enumerable: true, get: once('producer', producer) },
      environment: { configurable: true, enumerable: true, get: once('environment', environment) },
      redaction: { configurable: true, enumerable: true, get: once('redaction', redaction) },
      scenario: { configurable: true, enumerable: true, get: once('scenario', scenario) },
    });
    Object.defineProperties(producer, {
      name: { configurable: true, enumerable: true, get: once('producer.name', producer.name) },
      version: { configurable: true, enumerable: true, get: once('producer.version', producer.version) },
    });
    Object.defineProperties(environment, {
      runtime: { configurable: true, enumerable: true, get: once('environment.runtime', environment.runtime) },
      runtimeVersion: {
        configurable: true,
        enumerable: true,
        get: once('environment.runtimeVersion', environment.runtimeVersion),
      },
      executionSurface: {
        configurable: true,
        enumerable: true,
        get: once('environment.executionSurface', environment.executionSurface),
      },
    });
    Object.defineProperties(redaction, {
      applied: { configurable: true, enumerable: true, get: once('redaction.applied', redaction.applied) },
      policyVersion: {
        configurable: true,
        enumerable: true,
        get: once('redaction.policyVersion', redaction.policyVersion),
      },
    });
    Object.defineProperties(scenario, {
      feature: { configurable: true, enumerable: true, get: once('scenario.feature', scenario.feature) },
      scenario: { configurable: true, enumerable: true, get: once('scenario.scenario', scenario.scenario) },
      expectedResult: {
        configurable: true,
        enumerable: true,
        get: once('scenario.expectedResult', scenario.expectedResult),
      },
    });

    const result = await validateEvidenceEnvelope(envelope, createVerifiedValidationOptions());

    expect(result.status).toBe('valid');
    for (const key of [
      'producer',
      'environment',
      'redaction',
      'scenario',
      'producer.name',
      'producer.version',
      'environment.runtime',
      'environment.runtimeVersion',
      'environment.executionSurface',
      'redaction.applied',
      'redaction.policyVersion',
      'scenario.feature',
      'scenario.scenario',
      'scenario.expectedResult',
    ]) {
      expect(reads.get(key), key).toBe(1);
    }
  });

  it('uses the first executionSurface value for captured browser requirements', async () => {
    const envelope = createCapturedAndVerifiedEnvelope({ status: 'pass' });
    delete (envelope.environment as { browser?: unknown }).browser;
    let executionSurfaceReads = 0;
    Object.defineProperty(envelope.environment, 'executionSurface', {
      configurable: true,
      enumerable: true,
      get() {
        executionSurfaceReads += 1;
        return executionSurfaceReads === 1 ? 'browser-document' : 'unit-test';
      },
    });

    const result = await validateEvidenceEnvelope(envelope, createVerifiedValidationOptions());

    expect(executionSurfaceReads).toBe(1);
    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'missing-browser-metadata', path: '$.environment.browser' }),
    );
  });

  it('keeps captured-only metadata lazy for synthetic evidence', async () => {
    const envelope = createSyntheticEnvelope({ status: 'pass' }) as ReturnType<
      typeof createSyntheticEnvelope<{ status: string }>
    > & Record<string, unknown>;
    let scenarioReads = 0;
    let artifactReads = 0;
    let verificationReads = 0;
    Object.defineProperties(envelope, {
      scenario: {
        configurable: true,
        get() {
          scenarioReads += 1;
          throw new Error('synthetic evidence must not inspect scenario');
        },
      },
      artifact: {
        configurable: true,
        get() {
          artifactReads += 1;
          throw new Error('synthetic evidence must not inspect artifact');
        },
      },
      verification: {
        configurable: true,
        get() {
          verificationReads += 1;
          throw new Error('synthetic evidence must not inspect verification');
        },
      },
    });

    const result = await validateEvidenceEnvelope(envelope);

    expect(result.status).toBe('valid');
    expect(scenarioReads).toBe(0);
    expect(artifactReads).toBe(0);
    expect(verificationReads).toBe(0);
  });
});
