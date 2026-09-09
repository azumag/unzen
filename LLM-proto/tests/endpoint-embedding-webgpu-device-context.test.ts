import { describe, expect, it } from 'vitest';
import {
  validateCapturedEndpointEmbeddingWebGpuDeviceContext,
  validateEndpointEmbeddingWebGpuDeviceContextFields,
} from '../tools/verify_endpoint_embedding_webgpu_device_context.mjs';

function validDeviceContext() {
  return {
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 HeadlessChrome/152.0.0.0 Safari/537.36',
    adapterInfo: {
      vendor: 'apple',
      architecture: 'metal-3',
      device: '',
      description: '',
    },
    adapterLimits: {
      maxBufferSize: 1_073_741_824,
      maxStorageBufferBindingSize: 1_073_741_824,
      maxComputeWorkgroupStorageSize: 32_768,
    },
    captureEnvironment: {
      cdpBrowser: 'Chrome/152.0.7977.83',
    },
  };
}

describe('endpoint embedding WebGPU device-context fields', () => {
  it('accepts a captured Chrome major with finite positive WebGPU limits', () => {
    const evidence = validDeviceContext();
    expect(validateEndpointEmbeddingWebGpuDeviceContextFields(evidence)).toBe(evidence);
  });

  it('allows adapterInfo to be unavailable while retaining adapter limits', () => {
    const evidence = { ...validDeviceContext(), adapterInfo: null };
    expect(validateEndpointEmbeddingWebGpuDeviceContextFields(evidence)).toBe(evidence);
  });

  it.each([
    ['missing user agent', (evidence: any) => { delete evidence.userAgent; }],
    ['Chrome major drift', (evidence: any) => { evidence.captureEnvironment.cdpBrowser = 'Chrome/151.0.0.0'; }],
    ['malformed user agent', (evidence: any) => { evidence.userAgent = 'SyntheticBrowser/1.0'; }],
    ['array adapter info', (evidence: any) => { evidence.adapterInfo = []; }],
    ['non-string adapter field', (evidence: any) => { evidence.adapterInfo.vendor = 1234; }],
    ['missing adapter limits', (evidence: any) => { delete evidence.adapterLimits; }],
    ['zero buffer limit', (evidence: any) => { evidence.adapterLimits.maxBufferSize = 0; }],
    ['fractional storage limit', (evidence: any) => { evidence.adapterLimits.maxStorageBufferBindingSize = 1.5; }],
    ['non-finite workgroup limit', (evidence: any) => { evidence.adapterLimits.maxComputeWorkgroupStorageSize = Number.POSITIVE_INFINITY; }],
  ])('fails closed on %s', (_name, mutate) => {
    const evidence = validDeviceContext();
    mutate(evidence);
    expect(() => validateEndpointEmbeddingWebGpuDeviceContextFields(evidence)).toThrow();
  });

  it('runs the existing captured-envelope validator before device-context validation', () => {
    const evidence = validDeviceContext() as any;
    expect(() => validateCapturedEndpointEmbeddingWebGpuDeviceContext(evidence))
      .toThrow('captured evidence level drift');
  });
});
