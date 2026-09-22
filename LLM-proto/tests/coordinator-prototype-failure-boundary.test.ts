import { afterEach, describe, expect, it } from 'vitest';
import { AdaptiveChunkDispatcher } from '../src/adaptive-chunk-dispatcher.js';
import {
  createDefaultCoordinatorPrototypeManifest,
  runCoordinatorPrototype,
} from '../src/coordinator-prototype.js';

const originalDispatcherRun = AdaptiveChunkDispatcher.prototype.run;

describe('Coordinator prototype failure-reporting boundary', () => {
  afterEach(() => {
    AdaptiveChunkDispatcher.prototype.run = originalDispatcherRun;
  });

  it('snapshots requestId once for dispatch, fallback reporting, and the returned report', () => {
    const manifest = createDefaultCoordinatorPrototypeManifest();
    let requestIdReads = 0;
    Object.defineProperty(manifest, 'requestId', {
      configurable: true,
      get() {
        requestIdReads += 1;
        return requestIdReads === 1 ? 'stable-request-id' : 'mutated-request-id';
      },
    });
    AdaptiveChunkDispatcher.prototype.run = function (requestId: string) {
      expect(requestId).toBe('stable-request-id');
      throw new Error('dispatcher failed');
    };

    const report = runCoordinatorPrototype(manifest);

    expect(requestIdReads).toBe(1);
    expect(report.requestId).toBe('stable-request-id');
    expect(report.failureReason).toBe('dispatcher failed');
    expect(report.status).toBe('fail');
  });

  it('fails closed when the dispatcher throws a revoked Proxy', () => {
    const revocable = Proxy.revocable({}, {});
    const failure = revocable.proxy;
    revocable.revoke();
    AdaptiveChunkDispatcher.prototype.run = function () {
      throw failure;
    };

    const report = runCoordinatorPrototype(createDefaultCoordinatorPrototypeManifest());

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('Unknown error');
    expect(report.bottlenecksToIssue).toContain('coordinator-prototype-failure: Unknown error');
  });

  it('does not invoke caller coercion hooks while formatting object failures', () => {
    let coercions = 0;
    const failure = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        throw new Error('Symbol.toPrimitive must not run');
      },
      valueOf() {
        coercions += 1;
        throw new Error('valueOf must not run');
      },
      toString() {
        coercions += 1;
        throw new Error('toString must not run');
      },
    };
    AdaptiveChunkDispatcher.prototype.run = function () {
      throw failure;
    };

    const report = runCoordinatorPrototype(createDefaultCoordinatorPrototypeManifest());

    expect(coercions).toBe(0);
    expect(report.failureReason).toBe('Unknown error');
    expect(report.status).toBe('fail');
  });

  it('bounds hostile Error message access without coercing the thrown getter value', () => {
    let coercions = 0;
    const getterFailure = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        throw new Error('getter failure must not be coerced');
      },
    };
    const failure = new Proxy(new Error('hidden'), {
      get(target, property, receiver) {
        if (property === 'message') {
          throw getterFailure;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    AdaptiveChunkDispatcher.prototype.run = function () {
      throw failure;
    };

    const report = runCoordinatorPrototype(createDefaultCoordinatorPrototypeManifest());

    expect(coercions).toBe(0);
    expect(report.failureReason).toBe('Unknown error');
    expect(report.status).toBe('fail');
  });

  it('preserves an ordinary Error message', () => {
    AdaptiveChunkDispatcher.prototype.run = function () {
      throw new Error('ordinary dispatcher failure');
    };

    const report = runCoordinatorPrototype(createDefaultCoordinatorPrototypeManifest());

    expect(report.failureReason).toBe('ordinary dispatcher failure');
    expect(report.status).toBe('fail');
  });

  it.each([
    ['dispatcher-string', 'dispatcher-string'],
    [17, '17'],
    [null, 'null'],
    [undefined, 'undefined'],
  ] as const)('preserves safe primitive failure diagnostics for %p', (failure, expected) => {
    AdaptiveChunkDispatcher.prototype.run = function () {
      throw failure;
    };

    const report = runCoordinatorPrototype(createDefaultCoordinatorPrototypeManifest());

    expect(report.failureReason).toBe(expected);
    expect(report.status).toBe('fail');
  });
});
