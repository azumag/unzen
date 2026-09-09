import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('runs the prepared-bundle preflight before reserving output or launching Chrome', () => {
  const source = readFileSync(
    new URL('../tools/capture_endpoint_embedding_webgpu_runtime.mjs', import.meta.url),
    'utf8',
  );

  expect(source).toContain('preflightEndpointEmbeddingWebGpuCapture');
  expect(source).toContain("from './preflight_endpoint_embedding_webgpu_capture.mjs';");

  const harnessPortCheck = source.indexOf("await assertPortAvailable(serverPort, 'harness')");
  const debugPortCheck = source.indexOf("await assertPortAvailable(debugPort, 'DevTools')");
  const preflight = source.indexOf('await preflightEndpointEmbeddingWebGpuCapture({ dataDir, chromeBinary })');
  const reserveOutput = source.indexOf('outputFd = reserveEvidenceOutput(outputPath)');
  const createProfile = source.indexOf("mkdtempSync(join(tmpdir(), 'unzen-endpoint-embedding-webgpu-'))");
  const launchHarness = source.indexOf('server = spawn(process.execPath, [HARNESS]');
  const launchChrome = source.indexOf('chrome = spawn(chromeBinary');

  for (const position of [
    harnessPortCheck,
    debugPortCheck,
    preflight,
    reserveOutput,
    createProfile,
    launchHarness,
    launchChrome,
  ]) {
    expect(position).toBeGreaterThanOrEqual(0);
  }

  expect(harnessPortCheck).toBeLessThan(preflight);
  expect(debugPortCheck).toBeLessThan(preflight);
  expect(preflight).toBeLessThan(reserveOutput);
  expect(preflight).toBeLessThan(createProfile);
  expect(preflight).toBeLessThan(launchHarness);
  expect(preflight).toBeLessThan(launchChrome);
});
