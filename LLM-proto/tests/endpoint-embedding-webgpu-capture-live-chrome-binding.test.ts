import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateCaptureChromeCdpIdentity } from '../tools/capture_endpoint_embedding_webgpu_runtime.mjs';

const VALID_CDP_USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 HeadlessChrome/152.0.0.0 Safari/537.36';

function validPreflight() {
  return {
    chrome: {
      raw: 'Google Chrome 152.0.7977.83',
      version: '152.0.7977.83',
    },
  };
}

function cdpVersion(Browser: string, userAgent = VALID_CDP_USER_AGENT) {
  return { Browser, 'User-Agent': userAgent };
}

describe('endpoint embedding capture live Chrome identity binding', () => {
  it.each([
    'Chrome/152.0.7977.83',
    'HeadlessChrome/152.0.7977.83',
  ])('accepts an exact preflight/CDP four-part version match: %s', (Browser) => {
    expect(validateCaptureChromeCdpIdentity(validPreflight(), cdpVersion(Browser))).toBe(Browser);
  });

  it.each([
    ['different build', cdpVersion('Chrome/152.0.7978.1')],
    ['different major', cdpVersion('HeadlessChrome/151.0.7977.83')],
    ['non-Chrome Browser identity', cdpVersion('Firefox/152.0.7977.83')],
    ['missing Browser field', { 'User-Agent': VALID_CDP_USER_AGENT }],
    ['malformed Browser version', cdpVersion('Chrome/current')],
    ['missing User-Agent field', { Browser: 'Chrome/152.0.7977.83' }],
    ['Browser/User-Agent major drift', cdpVersion('Chrome/152.0.7977.83', 'Mozilla/5.0 HeadlessChrome/151.0.0.0 Safari/537.36')],
  ])('fails closed on %s', (_name, cdpVersionValue) => {
    expect(() => validateCaptureChromeCdpIdentity(validPreflight(), cdpVersionValue)).toThrow();
  });

  it('rejects malformed preflight executable identity', () => {
    const preflight = validPreflight();
    preflight.chrome.version = '152';
    expect(() => validateCaptureChromeCdpIdentity(preflight, cdpVersion('Chrome/152.0.7977.83')))
      .toThrow('four-part');
  });

  it('rejects drift between the preflight raw identity and parsed four-part version', () => {
    const preflight = validPreflight();
    preflight.chrome.raw = 'Google Chrome 152.0.7978.1';
    expect(() => validateCaptureChromeCdpIdentity(preflight, cdpVersion('Chrome/152.0.7977.83')))
      .toThrow('raw/version identity mismatch');
  });

  it('rejects a non-Chrome preflight raw identity even when the numeric version matches', () => {
    const preflight = validPreflight();
    preflight.chrome.raw = 'Mozilla Firefox 152.0.7977.83';
    expect(() => validateCaptureChromeCdpIdentity(preflight, cdpVersion('Chrome/152.0.7977.83')))
      .toThrow('Google Chrome/Chromium');
  });
});

it('binds the live CDP browser and user agent before navigating the expensive ORT Web harness and persists both identities', () => {
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
  expect(source).toContain("cdpUserAgent: version['User-Agent']");
  expect(source).not.toContain("execFileSync(chromeBinary, ['--version']");
});
