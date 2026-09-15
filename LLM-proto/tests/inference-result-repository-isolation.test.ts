import { describe, expect, it } from 'vitest';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { InMemoryRepository, type DurableRepository } from '../src/durable-repository.js';
import { generateRequestId } from '../src/ids.js';
import type { RequestRecord } from '../src/durable-types.js';
import type { InferenceRequestId, InferenceResult } from '../src/types.js';

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

function request(requestId: InferenceRequestId, stage: RequestRecord['stage'] = 'running'): RequestRecord {
  return {
    requestId,
    prompt: 'hello',
    stage,
    createdAt: 1_000,
    currentSegment: 0,
    totalSegments: 2,
    manifestDigest: 'd'.repeat(64),
    retryCount: 0,
  };
}

function plainResult(requestId: InferenceRequestId): InferenceResult {
  return {
    requestId,
    tokens: [11, 22, 33],
    text: 'done',
    totalTimeMs: 12,
    segmentsCompleted: 2,
  };
}

function hostileResult(): InferenceResult {
  return new Proxy({} as InferenceResult, {
    get() {
      throw new Error('result must not be read');
    },
    ownKeys() {
      throw new Error('result must not be enumerated');
    },
  });
}

describe('inference result repository isolation', () => {
  it.each(repositories())('%s captures result and token fields exactly once without iteration', (_name, repo) => {
    const requestId = generateRequestId();
    repo.createRequest(request(requestId));

    const values = plainResult(requestId);
    const resultReads: Record<keyof InferenceResult, number> = {
      requestId: 0,
      tokens: 0,
      text: 0,
      totalTimeMs: 0,
      segmentsCompleted: 0,
    };
    const tokenReads = { length: 0, 0: 0, 1: 0, 2: 0 };
    const tokenTarget = [11, 22, 33];
    const tokens = new Proxy(tokenTarget, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error('tokens must not be iterated');
        if (property === 'length') {
          tokenReads.length += 1;
          if (tokenReads.length > 1) throw new Error('token length read more than once');
        } else if (property === '0' || property === '1' || property === '2') {
          tokenReads[property] += 1;
          if (tokenReads[property] > 1) throw new Error(`token ${property} read more than once`);
        }
        return Reflect.get(target, property, receiver);
      },
      ownKeys() {
        throw new Error('tokens must not be enumerated');
      },
    });

    const target = {} as InferenceResult;
    for (const field of Object.keys(resultReads) as Array<keyof InferenceResult>) {
      Object.defineProperty(target, field, {
        enumerable: true,
        configurable: true,
        get() {
          resultReads[field] += 1;
          if (resultReads[field] > 1) throw new Error(`${String(field)} read more than once`);
          return field === 'tokens' ? tokens : values[field];
        },
      });
    }
    const result = new Proxy(target, {
      ownKeys() {
        throw new Error('result must not be enumerated');
      },
    });

    expect(repo.commitCompletion(requestId, 'running', result)).toBe('committed');
    expect(resultReads).toEqual({
      requestId: 1,
      tokens: 1,
      text: 1,
      totalTimeMs: 1,
      segmentsCompleted: 1,
    });
    expect(tokenReads).toEqual({ length: 1, 0: 1, 1: 1, 2: 1 });
    expect(repo.getResult(requestId)).toEqual(values);
  });

  it.each(repositories())('%s rejects a commit-eligible request/result identity mismatch without mutation', (_name, repo) => {
    const requestId = generateRequestId();
    const otherRequestId = generateRequestId();
    repo.createRequest(request(requestId));

    expect(() => repo.commitCompletion(requestId, 'running', plainResult(otherRequestId)))
      .toThrow('repository result requestId does not match route requestId');
    expect(repo.getResult(requestId)).toBeUndefined();
    expect(repo.getResult(otherRequestId)).toBeUndefined();
    expect(repo.getRequest(requestId)?.stage).toBe('running');
    expect(repo.getRequest(requestId)?.completedAt).toBeUndefined();
  });

  it.each(repositories())('%s binds the completion identity check to the single captured requestId', (_name, repo) => {
    const requestId = generateRequestId();
    const changedRequestId = generateRequestId();
    repo.createRequest(request(requestId));

    const result = plainResult(requestId) as InferenceResult & { requestId: InferenceRequestId };
    let requestIdReads = 0;
    Object.defineProperty(result, 'requestId', {
      enumerable: true,
      configurable: true,
      get() {
        requestIdReads += 1;
        return requestIdReads === 1 ? requestId : changedRequestId;
      },
    });

    expect(repo.commitCompletion(requestId, 'running', result)).toBe('committed');
    expect(requestIdReads).toBe(1);
    expect(repo.getResult(requestId)?.requestId).toBe(requestId);
    expect(repo.getResult(changedRequestId)).toBeUndefined();
  });

  it.each(repositories())('%s detaches retained commit inputs and read results including tokens', (_name, repo) => {
    const requestId = generateRequestId();
    repo.createRequest(request(requestId));
    const result = plainResult(requestId);
    const expected = { ...result, tokens: [...result.tokens] };

    expect(repo.commitCompletion(requestId, 'running', result)).toBe('committed');

    const mutableInput = result as {
      requestId: InferenceRequestId;
      tokens: number[];
      text: string;
      totalTimeMs: number;
      segmentsCompleted: number;
    };
    mutableInput.requestId = generateRequestId();
    mutableInput.tokens[0] = 999;
    mutableInput.tokens.push(44);
    mutableInput.text = 'mutated input';
    mutableInput.totalTimeMs = 999;
    mutableInput.segmentsCompleted = 99;
    expect(repo.getResult(requestId)).toEqual(expected);

    const read = repo.getResult(requestId)! as {
      requestId: InferenceRequestId;
      tokens: number[];
      text: string;
      totalTimeMs: number;
      segmentsCompleted: number;
    };
    read.requestId = generateRequestId();
    read.tokens[1] = 888;
    read.tokens.push(55);
    read.text = 'mutated read';
    read.totalTimeMs = 888;
    read.segmentsCompleted = 88;
    expect(repo.getResult(requestId)).toEqual(expected);
  });

  it.each(repositories())('%s preserves duplicate and conflict early returns without reading hostile results', (_name, repo) => {
    const duplicateId = generateRequestId();
    repo.createRequest(request(duplicateId));
    expect(repo.commitCompletion(duplicateId, 'running', plainResult(duplicateId))).toBe('committed');
    expect(repo.commitCompletion(duplicateId, 'running', hostileResult())).toBe('duplicate');

    const conflictId = generateRequestId();
    repo.createRequest(request(conflictId, 'accepted'));
    expect(repo.commitCompletion(conflictId, 'running', hostileResult())).toBe('conflict');
    expect(repo.getResult(conflictId)).toBeUndefined();
  });
});