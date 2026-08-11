/** Bounded response-body readers for untrusted network payloads. */

export class ResponseBodyLimitError extends Error {
  constructor(label: string, maximumBytes: number) {
    super(`${label} exceeds ${maximumBytes} bytes`);
    this.name = 'ResponseBodyLimitError';
  }
}

function responseSizeError(label: string, maximumBytes: number): Error {
  return new ResponseBodyLimitError(label, maximumBytes);
}

function assertDeclaredResponseSize(
  response: Response,
  maximumBytes: number,
  label: string,
): void {
  const headers = (response as Response & { headers?: Headers }).headers;
  const rawLength = headers?.get?.('Content-Length');
  if (rawLength === null || rawLength === undefined) return;

  const normalized = rawLength.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) return;
  const declaredBytes = Number(normalized);
  if (!Number.isFinite(declaredBytes) || declaredBytes > maximumBytes) {
    throw responseSizeError(label, maximumBytes);
  }
}

function cancelResponseBody(response: Response, reason: unknown): void {
  try {
    const cancellation = response.body?.cancel(reason);
    void cancellation?.catch(() => {});
  } catch {
    // Releasing a rejected body is best-effort and must not mask the size error.
  }
}

function assertDeclaredResponseSizeOrCancel(
  response: Response,
  maximumBytes: number,
  label: string,
): void {
  try {
    assertDeclaredResponseSize(response, maximumBytes, label);
  } catch (error) {
    cancelResponseBody(response, error);
    throw error;
  }
}

/** Read a response without allowing a missing/false Content-Length to bypass the cap. */
export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<ArrayBuffer> {
  assertDeclaredResponseSizeOrCancel(response, maximumBytes, label);

  const body = (response as Response & {
    body?: ReadableStream<Uint8Array> | null;
  }).body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        totalBytes += value.byteLength;
        if (totalBytes > maximumBytes) {
          void reader.cancel(responseSizeError(label, maximumBytes)).catch(() => {});
          throw responseSizeError(label, maximumBytes);
        }
        chunks.push(value.slice());
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  }

  const readArrayBuffer = (response as Response & {
    arrayBuffer?: () => Promise<ArrayBuffer>;
  }).arrayBuffer;
  if (typeof readArrayBuffer !== 'function') {
    throw new Error(`${label} body cannot be read`);
  }
  const bytes = await readArrayBuffer.call(response);
  if (bytes.byteLength > maximumBytes) {
    throw responseSizeError(label, maximumBytes);
  }
  return bytes;
}

/** Read and parse bounded UTF-8 JSON, with a fallback for lightweight test adapters. */
export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<unknown> {
  const body = (response as Response & {
    body?: ReadableStream<Uint8Array> | null;
  }).body;
  const readArrayBuffer = (response as Response & {
    arrayBuffer?: () => Promise<ArrayBuffer>;
  }).arrayBuffer;
  if ((body && typeof body.getReader === 'function') || typeof readArrayBuffer === 'function') {
    const bytes = await readBoundedResponseBytes(response, maximumBytes, label);
    let json: string;
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${label} is not valid UTF-8`);
    }
    if (json.charCodeAt(0) === 0xfeff) json = json.slice(1);
    return JSON.parse(json);
  }

  // Some embedders/tests expose only response.json(). Preflight declared size,
  // then retain a post-parse encoded-size check so the cap still applies.
  assertDeclaredResponseSizeOrCancel(response, maximumBytes, label);
  const parseJson = (response as Response & { json?: () => Promise<unknown> }).json;
  if (typeof parseJson !== 'function') {
    throw new Error(`${label} body cannot be read`);
  }
  const payload = await parseJson.call(response);
  const serialized = JSON.stringify(payload);
  if (
    typeof serialized !== 'string'
    || new TextEncoder().encode(serialized).byteLength > maximumBytes
  ) {
    throw responseSizeError(label, maximumBytes);
  }
  return payload;
}
