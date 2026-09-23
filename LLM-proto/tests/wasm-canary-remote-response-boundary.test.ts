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
});
