import { describe, expect, it } from 'vitest';
import { WASM_CANARY_CONTRACT } from '../tools/wasm_canary_contract.mjs';
import {
  WASM_CANARY_MAX_RESPONSE_BYTES,
  checkRemoteCanary,
} from '../tools/check_wasm_canary_remote.mjs';

const CANARY_URL = 'https://unzen-wasm-feasibility-canary.example.workers.dev/';

function oneResponseFetch(responseFactory: () => Response): typeof fetch {
  return async () => responseFactory();
}

describe('remote Wasm canary response boundary', () => {
  it('rejects malformed UTF-8 before replacement decoding can normalize valid JSON', async () => {
    const prefix = new TextEncoder().encode(
      `${JSON.stringify({ status: 'pass', ...WASM_CANARY_CONTRACT }).slice(0, -1)},"note":"`,
    );
    const suffix = new TextEncoder().encode('"}');
    const bytes = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
    bytes.set(prefix, 0);
    bytes[prefix.byteLength] = 0xff;
    bytes.set(suffix, prefix.byteLength + 1);

    expect(() => JSON.parse(new TextDecoder().decode(bytes))).not.toThrow();

    await expect(checkRemoteCanary(CANARY_URL, {
      samples: 1,
      fetchImpl: oneResponseFetch(() => new Response(bytes, { status: 200 })),
    })).rejects.toThrow(/not valid UTF-8/);
  });

  it('rejects a successful response above the explicit byte ceiling before JSON parsing', async () => {
    const bytes = new Uint8Array(WASM_CANARY_MAX_RESPONSE_BYTES + 1);
    bytes.fill(0x20);

    await expect(checkRemoteCanary(CANARY_URL, {
      samples: 1,
      fetchImpl: oneResponseFetch(() => new Response(bytes, { status: 200 })),
    })).rejects.toThrow(new RegExp(`exceeded ${WASM_CANARY_MAX_RESPONSE_BYTES} bytes`));
  });

  it('preserves valid UTF-8 BOM responses', async () => {
    const json = new TextEncoder().encode(JSON.stringify({ status: 'pass', ...WASM_CANARY_CONTRACT }));
    const bytes = new Uint8Array(3 + json.byteLength);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(json, 3);

    const report = await checkRemoteCanary(CANARY_URL, {
      samples: 1,
      fetchImpl: oneResponseFetch(() => new Response(bytes, { status: 200 })),
    });

    expect(report.status).toBe('pass');
    expect(report.samples).toHaveLength(1);
  });

  it('measures elapsed time after the bounded response body has been consumed', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ status: 'pass', ...WASM_CANARY_CONTRACT }));
    let bodyRead = false;
    let readCount = 0;
    const response = {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              readCount += 1;
              if (readCount === 1) {
                bodyRead = true;
                return { value: bytes, done: false };
              }
              return { value: undefined, done: true };
            },
            releaseLock() {},
          };
        },
      },
    } as unknown as Response;
    let clockCalls = 0;

    const report = await checkRemoteCanary(CANARY_URL, {
      samples: 1,
      fetchImpl: (async () => response) as typeof fetch,
      now: () => {
        clockCalls += 1;
        if (clockCalls === 2) expect(bodyRead).toBe(true);
        return clockCalls === 1 ? 100 : 175;
      },
    });

    expect(report.samples).toEqual([{ sample: 1, elapsedMs: 75 }]);
    expect(clockCalls).toBe(2);
  });

  it('best-effort cancels an unread non-success response body', async () => {
    let cancelled = false;
    const response = {
      ok: false,
      status: 503,
      body: {
        cancel() {
          cancelled = true;
          return Promise.resolve();
        },
      },
    } as unknown as Response;

    await expect(checkRemoteCanary(CANARY_URL, {
      samples: 1,
      fetchImpl: (async () => response) as typeof fetch,
    })).rejects.toThrow('Wasm canary returned HTTP 503.');

    expect(cancelled).toBe(true);
  });
});
