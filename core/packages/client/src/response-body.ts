/** Bounded response-body readers for untrusted network payloads. */

export class ResponseBodyLimitError extends Error {
  constructor(label: string, maximumBytes: number) {
    super(`${label} exceeds ${maximumBytes} bytes`);
    this.name = 'ResponseBodyLimitError';
  }
}

const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const ARRAY_BUFFER_SLICE = ArrayBuffer.prototype.slice;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get;
const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;

function responseSizeError(label: string, maximumBytes: number): Error {
  return new ResponseBodyLimitError(label, maximumBytes);
}

function snapshotArrayBuffer(
  value: unknown,
  maximumBytes: number,
  label: string,
): ArrayBuffer {
  try {
    if (!ARRAY_BUFFER_BYTE_LENGTH_GETTER) throw new TypeError('missing byteLength getter');
    const byteLength = Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GETTER, value, []) as number;
    if (byteLength > maximumBytes) throw responseSizeError(label, maximumBytes);
    return Reflect.apply(ARRAY_BUFFER_SLICE, value, [0]) as ArrayBuffer;
  } catch (error) {
    if (error instanceof ResponseBodyLimitError) throw error;
    throw new Error(`${label} body cannot be read`);
  }
}

function snapshotUint8ArrayChunk(
  value: unknown,
  maximumBytes: number,
  label: string,
): Uint8Array {
  try {
    if (!TYPED_ARRAY_BYTE_LENGTH_GETTER || !TYPED_ARRAY_TAG_GETTER) {
      throw new TypeError('missing typed array getter');
    }
    const tag = Reflect.apply(TYPED_ARRAY_TAG_GETTER, value, []) as string;
    if (tag !== 'Uint8Array') throw new TypeError('invalid response chunk');
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []) as number;
    if (byteLength > maximumBytes) throw responseSizeError(label, maximumBytes);
    const snapshot = new Uint8Array(byteLength);
    Reflect.apply(UINT8_ARRAY_SET, snapshot, [value, 0]);
    return snapshot;
  } catch (error) {
    if (error instanceof ResponseBodyLimitError) throw error;
    throw new Error(`${label} body returned a non-byte chunk`);
  }
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

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): void {
  try {
    void Promise.resolve(reader.cancel(reason)).catch(() => {});
  } catch {
    // Reader cleanup is best-effort and must not replace the body error.
  }
}

function releaseReaderLock(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // A custom adapter's cleanup failure cannot invalidate captured bytes.
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
    let readerCancelled = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        let chunk: Uint8Array;
        try {
          chunk = snapshotUint8ArrayChunk(value, maximumBytes - totalBytes, label);
        } catch (error) {
          if (error instanceof ResponseBodyLimitError) {
            readerCancelled = true;
            cancelReader(reader, responseSizeError(label, maximumBytes));
            throw responseSizeError(label, maximumBytes);
          }
          throw error;
        }
        totalBytes += chunk.byteLength;
        chunks.push(chunk);
      }
    } catch (error) {
      if (!readerCancelled) cancelReader(reader, error);
      throw error;
    } finally {
      releaseReaderLock(reader);
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
  const bytes: unknown = await readArrayBuffer.call(response);
  return snapshotArrayBuffer(bytes, maximumBytes, label);
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
  return JSON.parse(serialized);
}
