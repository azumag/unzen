import { describe, expect, it } from 'vitest';
import { createCheckpointEnvelope } from '../src/checkpoint-envelope.js';
import type { CheckpointEnvelope } from '../src/checkpoint-envelope.js';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { InMemoryRepository, type DurableRepository } from '../src/durable-repository.js';
import {
  generateAttemptId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import { workerId } from '../src/types.js';

class ReferenceKv implements DurableObjectSyncKvStorage {
  private readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  put<T = unknown>(key: string, value: T): void {
    this.values.set(key, value);
  }

  delete(key: string): boolean {
    return this.values.delete(key);
  }

  list<T = unknown>(options: {
    readonly prefix?: string;
    readonly start?: string;
    readonly startAfter?: string;
    readonly end?: string;
    readonly reverse?: boolean;
    readonly limit?: number;
  } = {}): Iterable<[string, T]> {
    let entries = [...this.values.entries()]
      .filter(([key]) => options.prefix === undefined || key.startsWith(options.prefix))
      .filter(([key]) => options.start === undefined || key >= options.start)
      .filter(([key]) => options.startAfter === undefined || key > options.startAfter)
      .filter(([key]) => options.end === undefined || key < options.end)
      .sort(([a], [b]) => a.localeCompare(b));
    if (options.reverse) entries = entries.reverse();
    if (options.limit !== undefined) entries = entries.slice(0, options.limit);
    return entries.map(([key, value]) => [key, value as T]);
  }
}

function repositories(): Array<[string, DurableRepository]> {
  return [
    ['in-memory', new InMemoryRepository()],
    ['durable-object-reference-storage', new DurableObjectRepository(new ReferenceKv())],
  ];
}

async function checkpoint(overrides: Partial<CheckpointEnvelope> = {}): Promise<CheckpointEnvelope> {
  const envelope = await createCheckpointEnvelope({
    requestId: generateRequestId(),
    attemptId: generateAttemptId(),
    segmentIndex: 0,
    workerId: workerId('w0'),
    workerGeneration: generateWorkerGeneration(),
    modelManifestDigest: 'd'.repeat(64),
    formatVersion: 'float16',
    payload: new Uint8Array([1, 2, 3]),
    ttlMs: 60_000,
    createdAt: 1_000,
  });
  return { ...envelope, ...overrides };
}

function plain(envelope: CheckpointEnvelope) {
  return {
    requestId: envelope.requestId,
    attemptId: envelope.attemptId,
    segmentIndex: envelope.segmentIndex,
    workerId: envelope.workerId,
    workerGeneration: envelope.workerGeneration,
    modelManifestDigest: envelope.modelManifestDigest,
    formatVersion: envelope.formatVersion,
    payloadLength: envelope.payloadLength,
    payloadDigest: envelope.payloadDigest,
    createdAt: envelope.createdAt,
    ttlMs: envelope.ttlMs,
    previousCheckpointDigest: envelope.previousCheckpointDigest,
    payload: Array.from(envelope.payload),
  };
}

function mutable(envelope: CheckpointEnvelope) {
  return envelope as unknown as {
    requestId: CheckpointEnvelope['requestId'];
    attemptId: CheckpointEnvelope['attemptId'];
    segmentIndex: number;
    workerId: CheckpointEnvelope['workerId'];
    workerGeneration: CheckpointEnvelope['workerGeneration'];
    modelManifestDigest: string;
    formatVersion: string;
    payloadLength: number;
    payloadDigest: string;
    createdAt: number;
    ttlMs: number;
    previousCheckpointDigest?: string;
    payload: Uint8Array;
  };
}

describe('checkpoint repository isolation', () => {
  it.each(repositories())('%s captures every stored field once and copies payload bytes without iteration', async (_name, repo) => {
    const values = await checkpoint();
    const fields: Array<Exclude<keyof CheckpointEnvelope, 'payload'>> = [
      'requestId',
      'attemptId',
      'segmentIndex',
      'workerId',
      'workerGeneration',
      'modelManifestDigest',
      'formatVersion',
      'payloadLength',
      'payloadDigest',
      'createdAt',
      'ttlMs',
      'previousCheckpointDigest',
    ];
    const reads = Object.fromEntries(fields.map((field) => [field, 0])) as Record<Exclude<keyof CheckpointEnvelope, 'payload'>, number>;
    let payloadReads = 0;
    const byteReads = [0, 0, 0];
    let byteLengthReads = 0;
    const payloadTarget = new Uint8Array([1, 2, 3]);
    const payload = new Proxy(payloadTarget, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error('payload must not be iterated');
        if (property === 'byteLength') {
          byteLengthReads += 1;
          if (byteLengthReads > 1) throw new Error('payload byteLength read more than once');
          return target.byteLength;
        }
        if (property === '0' || property === '1' || property === '2') {
          const index = Number(property);
          byteReads[index] += 1;
          if (byteReads[index] > 1) throw new Error(`payload byte ${index} read more than once`);
          return target[index];
        }
        return Reflect.get(target, property, receiver);
      },
      ownKeys() {
        throw new Error('payload must not be enumerated');
      },
    });

    const target = {} as CheckpointEnvelope;
    for (const field of fields) {
      Object.defineProperty(target, field, {
        enumerable: true,
        configurable: true,
        get() {
          reads[field] += 1;
          if (reads[field] > 1) throw new Error(`${String(field)} read more than once`);
          return values[field];
        },
      });
    }
    Object.defineProperty(target, 'payload', {
      enumerable: true,
      configurable: true,
      get() {
        payloadReads += 1;
        if (payloadReads > 1) throw new Error('payload read more than once');
        return payload;
      },
    });
    const envelope = new Proxy(target, {
      ownKeys() {
        throw new Error('checkpoint envelope must not be enumerated');
      },
    });

    expect(repo.putCheckpoint(envelope)).toBe('stored');
    expect(Object.values(reads).every((count) => count === 1)).toBe(true);
    expect(payloadReads).toBe(1);
    expect(byteLengthReads).toBe(1);
    expect(byteReads).toEqual([1, 1, 1]);
    expect(plain(repo.getCheckpoint(values.requestId, values.segmentIndex)!)).toEqual(plain(values));
  });

  it.each(repositories())('%s detaches retained write inputs and every checkpoint read surface', async (_name, repo) => {
    const envelope = await checkpoint();
    const requestId = envelope.requestId;
    const segmentIndex = envelope.segmentIndex;
    const expected = plain(envelope);

    expect(repo.putCheckpoint(envelope)).toBe('stored');

    const input = mutable(envelope);
    input.attemptId = generateAttemptId();
    input.workerId = workerId('mutated-writer');
    input.modelManifestDigest = 'e'.repeat(64);
    input.createdAt = 999_999;
    input.payload[0] = 99;
    expect(plain(repo.getCheckpoint(requestId, segmentIndex)!)).toEqual(expected);

    const read = mutable(repo.getCheckpoint(requestId, segmentIndex)!);
    read.attemptId = generateAttemptId();
    read.ttlMs = 1;
    read.payload[1] = 88;
    expect(plain(repo.getCheckpoint(requestId, segmentIndex)!)).toEqual(expected);

    const listed = mutable(repo.listCheckpoints(requestId)[0]!);
    listed.formatVersion = 'changed';
    listed.payload[2] = 77;
    expect(plain(repo.getCheckpoint(requestId, segmentIndex)!)).toEqual(expected);

    const all = mutable(repo.allCheckpoints()[0]!);
    all.payloadDigest = 'f'.repeat(64);
    all.payload[0] = 66;
    expect(plain(repo.getCheckpoint(requestId, segmentIndex)!)).toEqual(expected);
  });

  it.each(repositories())('%s classifies occupied slots without reading payload or unrelated metadata', async (_name, repo) => {
    const stored = await checkpoint();
    expect(repo.putCheckpoint(stored)).toBe('stored');

    for (const [payloadDigest, expected] of [
      [stored.payloadDigest, 'unchanged'],
      ['f'.repeat(64), 'conflict'],
    ] as const) {
      const reads = { requestId: 0, segmentIndex: 0, payloadDigest: 0 };
      const target = {} as CheckpointEnvelope;
      for (const field of ['requestId', 'segmentIndex', 'payloadDigest'] as const) {
        Object.defineProperty(target, field, {
          configurable: true,
          enumerable: true,
          get() {
            reads[field] += 1;
            if (reads[field] > 1) throw new Error(`${field} read more than once`);
            if (field === 'requestId') return stored.requestId;
            if (field === 'segmentIndex') return stored.segmentIndex;
            return payloadDigest;
          },
        });
      }
      for (const field of [
        'attemptId',
        'workerId',
        'workerGeneration',
        'modelManifestDigest',
        'formatVersion',
        'payloadLength',
        'createdAt',
        'ttlMs',
        'previousCheckpointDigest',
        'payload',
      ] as const) {
        Object.defineProperty(target, field, {
          configurable: true,
          enumerable: true,
          get() {
            throw new Error(`${field} must not be read on occupied-slot classification`);
          },
        });
      }
      const incoming = new Proxy(target, {
        ownKeys() {
          throw new Error('checkpoint envelope must not be enumerated');
        },
      });

      expect(repo.putCheckpoint(incoming)).toBe(expected);
      expect(reads).toEqual({ requestId: 1, segmentIndex: 1, payloadDigest: 1 });
    }
  });

  it.each(repositories())('%s returns an owned snapshot when collecting expired checkpoints', async (_name, repo) => {
    const envelope = await checkpoint({ createdAt: 10, ttlMs: 5 });
    const expected = plain(envelope);
    expect(repo.putCheckpoint(envelope)).toBe('stored');

    const input = mutable(envelope);
    input.payload[0] = 99;
    input.ttlMs = 100_000;

    const expired = repo.collectExpiredCheckpoints(15);
    expect(expired).toHaveLength(1);
    expect(plain(expired[0]!)).toEqual(expected);
    expect(repo.getCheckpoint(envelope.requestId, envelope.segmentIndex)).toBeUndefined();
  });
});
