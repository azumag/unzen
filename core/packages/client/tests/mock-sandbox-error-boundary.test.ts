import { describe, expect, it } from 'vitest';
import { UnzenFunctionError } from '@unzen/shared';
import { MockSandboxExecutor } from '../src/quickjs-sandbox';

describe('MockSandboxExecutor thrown-value boundary', () => {
  it('normalizes a revoked Proxy thrown by user code', async () => {
    const executor = new MockSandboxExecutor();

    await expect(executor.execute(`
      function run() {
        const pair = Proxy.revocable({}, {});
        pair.revoke();
        throw pair.proxy;
      }
    `, [])).rejects.toMatchObject({
      name: expect.any(String),
      message: 'Unknown error',
    });

    await expect(executor.execute(`
      function run() {
        const pair = Proxy.revocable({}, {});
        pair.revoke();
        throw pair.proxy;
      }
    `, [])).rejects.toBeInstanceOf(UnzenFunctionError);

    executor.dispose();
  });

  it('does not invoke coercion hooks on object values thrown by user code', async () => {
    const executor = new MockSandboxExecutor();

    await expect(executor.execute(`
      function run() {
        throw {
          [Symbol.toPrimitive]() {
            throw new Error('coercion hook must not run');
          },
          toString() {
            throw new Error('toString must not run');
          }
        };
      }
    `, [])).rejects.toMatchObject({
      message: 'Unknown error',
    });

    executor.dispose();
  });

  it('preserves ordinary Error messages', async () => {
    const executor = new MockSandboxExecutor();

    await expect(executor.execute(
      'function run() { throw new Error("ordinary failure"); }',
      [],
    )).rejects.toMatchObject({
      message: 'ordinary failure',
    });

    executor.dispose();
  });

  it('preserves primitive thrown-value text', async () => {
    const executor = new MockSandboxExecutor();

    await expect(executor.execute(
      'function run() { throw "primitive failure"; }',
      [],
    )).rejects.toMatchObject({
      message: 'primitive failure',
    });

    executor.dispose();
  });
});
