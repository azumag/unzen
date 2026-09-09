import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateCaptureChromeCdpIdentity } from '../tools/capture_endpoint_embedding_webgpu_runtime.mjs';

function validPreflight() {
  return {
    chrome: {
      raw: 'Google Chrome 152.0.7977.83',
      version: '152.0.7977.83',
    },
  };
}

describe('endpoint embedding capture live Chrome identity binding', () => {
  it.each([
    'Chrome/152.0.7977.83',
    'HeadlessChrome/152.0.7977.83',
  ])('accepts an exact preflight/CDP four-part version match: %s', (Browser) => {
    expect(validateCaptureChromeCdpIdentity(validPreflight(), { Browser })).toBe(Browser);
  });

  it.each([
    ['different build', { Browser: 'Chrome/152.0.7978.1' }],
    ['different major', { Browser: 'HeadlessChrome/151.0.7977.83' }],
    ['missing Browser field', {}],
    ['malformed Browser version', { Browser: 'Chrome/current' }],
  ])('fails closed on %s', (_name, cdpVersion) => {
    expect(() => validateCaptureChromeCdpIdentity(validPreflight(), cdpVersion)).toThrow();
  });

  it('rejects malformed preflight executable identity', () => {
    const preflight = validPreflight();
    preflight.chrome.version = '152';
    expect(() => validateCaptureChromeCdpIdentity(preflight, { Browser: 'Chrome/152.0.7977.83' }))
      .toThrow('four-part');
  });
});

it('binds the live CDP browser before navigating the expensive ORT Web harness and persists the preflight identity', () => {
  const source = readFileSync(
    new URL('../tools/capture_endpoint_embedding_webgpu_runtime.mjs', import.meta.url),
    'utf8',
  );
  const preflightIndex = source.indexOf('const preflight = await preflightEndpointEmbeddingWebGpuCapture');
  const liveBindingIndex = source.indexOf('validateCaptureChromeCdpIdentity(preflight, version)');
  const navigateIndex = source.indexOf("await cdp.send('Page.navigate', { url: harnessUrl })");
  const runtimePollingIndex = source.indexOf("expression: 'JSON.stringify(window.__unzenEndpointEmbeddingWebGpuReport ?? null)'");

  expect(preflightIndex).toBeGreaterThanOrEqual(0);
  expect(liveBindingIndex).toBeGreaterThan(preflightIndex);
  expect(liveBindingIndex).toBeLessThan(navigateIndex);
  expect(liveBindingIndex).toBeLessThan(runtimePollingIndex);
  expect(source).toContain('chromeVersion: preflight.chrome.raw');
  expect(source).not.toContain("execFileSync(chromeBinary, ['--version']");
});
