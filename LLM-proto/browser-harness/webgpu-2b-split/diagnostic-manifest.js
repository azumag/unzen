import { readResponseBytesBounded } from './artifact-cache.js';

// Keep endpoint diagnostic control documents under the same 4 MiB browser
// ceiling used by the main split-manifest loader. This is an input-memory
// boundary, not a model-artifact or production runtime budget.
export const ENDPOINT_DIAGNOSTIC_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

const utf8Decoder = new TextDecoder();

export async function readEndpointDiagnosticManifestResponse(
  response,
  url = './data/manifest.json',
) {
  const bytes = await readResponseBytesBounded(response, {
    maxBytes: ENDPOINT_DIAGNOSTIC_MANIFEST_MAX_BYTES,
    url,
  });
  return JSON.parse(utf8Decoder.decode(bytes));
}
