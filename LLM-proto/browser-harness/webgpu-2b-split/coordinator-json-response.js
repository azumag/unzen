import { readResponseBytesBounded } from './artifact-cache.js';

export async function readCoordinatorJsonResponse(
  response,
  { maxBytes, label, signal },
) {
  const bytes = await readResponseBytesBounded(response, {
    maxBytes,
    url: label,
    signal,
  });
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text);
}
