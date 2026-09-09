import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateEndpointEmbeddingWebGpuHostProbeResult } from '../tools/probe_endpoint_embedding_webgpu_host.mjs';

function validResult() {
  return {
    status: 'pass',
    secureContext: true,
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 HeadlessChrome/152.0.0.0 Safari/537.36',
    adapterInfo: {
      vendor: 'test-vendor',
      architecture: '',
      device: '',
      description: '',
    },
    adapterLimits: {
      maxBufferSize: 1_073_741_824,
      maxStorageBufferBindingSize: 1_073_741_824,
      maxComputeWorkgroupStorageSize: 65_536,
    },
    deviceLimits: {
      maxBufferSize: 268_435_456,
      maxStorageBufferBindingSize: 134_217_728,
      maxComputeWorkgroupStorageSize: 32_768,
    },
    deviceCreated: true,
    deviceDestroyed: true,
  };
}

describe('endpoint embedding WebGPU lightweight host probe result', () => {
  it('accepts a secure Chrome result with a created/destroyed device and bounded limits', () => {
    const result = validResult();
    expect(validateEndpointEmbeddingWebGpuHostProbeResult(result)).toBe(result);
  });

  it.each([
    ['browser-reported failure', (result: any) => { result.status = 'fail'; result.error = 'WebGPU unavailable'; }],
    ['insecure context', (result: any) => { result.secureContext = false; }],
    ['non-Chrome user agent', (result: any) => { result.userAgent = 'Mozilla/5.0 Safari/605.1.15'; }],
    ['missing adapter limit', (result: any) => { delete result.adapterLimits.maxBufferSize; }],
    ['non-integer device limit', (result: any) => { result.deviceLimits.maxBufferSize = 1.5; }],
    ['device limit above adapter limit', (result: any) => { result.deviceLimits.maxBufferSize = result.adapterLimits.maxBufferSize + 1; }],
    ['missing device creation evidence', (result: any) => { result.deviceCreated = false; }],
    ['missing device destruction evidence', (result: any) => { result.deviceDestroyed = false; }],
  ])('fails closed for %s', (_label, mutate) => {
    const result: any = validResult();
    mutate(result);
    expect(() => validateEndpointEmbeddingWebGpuHostProbeResult(result)).toThrow();
  });
});

it('keeps the host probe lightweight, isolated, loopback-only, and aligned with capture WebGPU flags', () => {
  const source = readFileSync(
    new URL('../tools/probe_endpoint_embedding_webgpu_host.mjs', import.meta.url),
    'utf8',
  );
  expect(source).toContain("server.listen({ host: '127.0.0.1', port: 0, exclusive: true }");
  expect(source).toContain("'--headless=new'");
  expect(source).toContain("'--disable-gpu-sandbox'");
  expect(source).toContain("'--enable-unsafe-webgpu'");
  expect(source).toContain('await navigator.gpu.requestAdapter()');
  expect(source).toContain('await adapter.requestDevice()');
  expect(source).toContain('device.destroy()');
  expect(source).toContain("mkdtempSync(join(tmpdir(), 'unzen-endpoint-embedding-webgpu-host-probe-'))");
});

it('runs the lightweight Chrome/WebGPU host probe before hashing the prepared ~1 GiB payload set', () => {
  const source = readFileSync(
    new URL('../tools/preflight_endpoint_embedding_webgpu_capture.mjs', import.meta.url),
    'utf8',
  );
  const hostProbe = source.indexOf('await probeEndpointEmbeddingWebGpuHost({ chromeBinary })');
  const graphHashing = source.indexOf('for (const [variantName, variant] of Object.entries(EXPECTED.graphVariants))');
  const payloadHashing = source.indexOf('for (const artifact of EXPECTED.physicalArtifacts)');
  expect(hostProbe).toBeGreaterThan(-1);
  expect(graphHashing).toBeGreaterThan(hostProbe);
  expect(payloadHashing).toBeGreaterThan(hostProbe);
});
