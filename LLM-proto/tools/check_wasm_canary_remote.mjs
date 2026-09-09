import { validateWasmCanaryPayload } from './wasm_canary_contract.mjs';

export function validateCanaryUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('Wasm canary smoke URL must use https.');
  }
  if (!url.hostname.endsWith('.workers.dev')) {
    throw new Error('Wasm canary smoke URL must be an isolated *.workers.dev hostname.');
  }
  if (url.username || url.password) {
    throw new Error('Wasm canary smoke URL must not contain credentials.');
  }
  return url;
}

export async function checkRemoteCanary(urlValue, { fetchImpl = fetch, samples = 4 } = {}) {
  const url = validateCanaryUrl(urlValue);
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 20) {
    throw new Error('samples must be an integer between 1 and 20.');
  }

  const results = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const startedAt = performance.now();
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    const elapsedMs = performance.now() - startedAt;
    if (!response.ok) {
      throw new Error(`Wasm canary returned HTTP ${response.status}.`);
    }
    const payload = await response.json();
    const validation = validateWasmCanaryPayload(payload);
    if (validation.status !== 'valid') {
      throw new Error(`Wasm canary contract failed: ${JSON.stringify(validation)}`);
    }
    results.push({ sample: sample + 1, elapsedMs });
  }

  return {
    status: 'pass',
    url: url.toString(),
    samples: results,
  };
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    throw new Error('Usage: node tools/check_wasm_canary_remote.mjs https://<isolated-canary>.workers.dev/');
  }
  const report = await checkRemoteCanary(url);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1]?.endsWith('check_wasm_canary_remote.mjs')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
