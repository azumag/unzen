import { describe, expect, it } from 'vitest';
import {
  parseEndpointEmbeddingWebGpuHostProbeResultBytes,
} from '../tools/probe_endpoint_embedding_webgpu_host.mjs';

describe('endpoint embedding WebGPU host probe result UTF-8 boundary', () => {
  it('rejects malformed UTF-8 before JSON parsing can normalize it', () => {
    const bytes = Buffer.concat([
      Buffer.from('{"status":"pass","adapter":"', 'utf8'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}', 'utf8'),
    ]);

    expect(() => parseEndpointEmbeddingWebGpuHostProbeResultBytes(bytes))
      .toThrow('WebGPU host probe result is not valid UTF-8');
  });

  it('accepts valid non-ASCII UTF-8 JSON exactly', () => {
    const parsed = parseEndpointEmbeddingWebGpuHostProbeResultBytes(
      Buffer.from(JSON.stringify({ status: 'pass', adapter: '日本語アダプター' }), 'utf8'),
    );

    expect(parsed).toEqual({ status: 'pass', adapter: '日本語アダプター' });
  });

  it('preserves the previous JSON.parse behavior for a leading UTF-8 BOM', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"status":"pass"}', 'utf8'),
    ]);

    expect(() => parseEndpointEmbeddingWebGpuHostProbeResultBytes(bytes)).toThrow();
  });
});
