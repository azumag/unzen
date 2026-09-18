/** Bounded JSON request reader for the untrusted fallback transport. */

export class RequestBodyLimitError extends Error {
  constructor(label: string, maximumBytes: number) {
    super(`${label} exceeds ${maximumBytes} bytes`);
    this.name = 'RequestBodyLimitError';
  }
}

function bodyLimitError(label: string, maximumBytes: number): RequestBodyLimitError {
  return new RequestBodyLimitError(label, maximumBytes);
}

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
const STRING_TRIM = String.prototype.trim;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;

function snapshotRequestChunk(
  value: unknown,
  maximumBytes: number,
  label: string,
): Uint8Array {
  try {
    if (!TYPED_ARRAY_BYTE_LENGTH_GETTER || !TYPED_ARRAY_TAG_GETTER) {
      throw new TypeError('missing typed array getter');
    }
    const tag = Reflect.apply(TYPED_ARRAY_TAG_GETTER, value, []) as string;
    if (tag !== 'Uint8Array') throw new TypeError('invalid request chunk');
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []) as number;
    if (byteLength > maximumBytes) throw bodyLimitError(label, maximumBytes);
    const snapshot = new Uint8Array(byteLength);
    Reflect.apply(UINT8_ARRAY_SET, snapshot, [value, 0]);
    return snapshot;
  } catch (error) {
    if (error instanceof RequestBodyLimitError) throw error;
    throw new TypeError(`${label} body returned a non-byte chunk`);
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
    // A custom request adapter's cleanup failure must not mask the result.
  }
}

/** Release an inbound body when a route rejects it before parsing. */
export function cancelUnreadRequestBody(request: Request): void {
  try {
    const cancellation = request.body?.cancel();
    void cancellation?.catch(() => {});
  } catch {
    // Body release is best-effort and must not replace the intended response.
  }
}

function assertMaximumBytes(maximumBytes: number, label: string): void {
  if (!NUMBER_IS_SAFE_INTEGER(maximumBytes) || maximumBytes < 0) {
    throw new RangeError(`${label} maximumBytes must be a non-negative safe integer`);
  }
}

function assertDeclaredRequestSize(
  request: Request,
  maximumBytes: number,
  label: string,
): void {
  const headers = (request as Request & { headers?: Headers }).headers;
  const rawLength: unknown = headers?.get?.('Content-Length');
  if (typeof rawLength !== 'string') return;

  const normalized = Reflect.apply(STRING_TRIM, rawLength, []) as string;
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) return;
  const declaredBytes = Number(normalized);
  if (!Number.isFinite(declaredBytes) || declaredBytes > maximumBytes) {
    throw bodyLimitError(label, maximumBytes);
  }
}

function assertBoundedRequestPreflightOrCancel(
  request: Request,
  maximumBytes: number,
  label: string,
): void {
  try {
    assertMaximumBytes(maximumBytes, label);
    assertDeclaredRequestSize(request, maximumBytes, label);
  } catch (error) {
    cancelUnreadRequestBody(request);
    throw error;
  }
}

export async function readBoundedJsonRequest(
  request: Request,
  maximumBytes: number,
  label: string,
): Promise<unknown> {
  assertBoundedRequestPreflightOrCancel(request, maximumBytes, label);

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const body = request.body;
  if (body) {
    const reader = body.getReader();
    let readerCancelled = false;
    try {
      while (true) {
        const result: unknown = await reader.read();
        if (result === null || typeof result !== 'object') {
          throw new TypeError(`${label} body returned an invalid reader result`);
        }
        const done = (result as { done?: unknown }).done;
        if (typeof done !== 'boolean') {
          throw new TypeError(`${label} body returned a non-boolean done flag`);
        }
        if (done) break;
        const value = (result as { value?: unknown }).value;
        let chunk: Uint8Array;
        try {
          chunk = snapshotRequestChunk(value, maximumBytes - totalBytes, label);
        } catch (error) {
          if (error instanceof RequestBodyLimitError) {
            readerCancelled = true;
            cancelReader(reader, bodyLimitError(label, maximumBytes));
            throw bodyLimitError(label, maximumBytes);
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
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError(`${label} is not valid UTF-8`);
  }
  if (json.charCodeAt(0) === 0xfeff) json = json.slice(1);
  return JSON.parse(json);
}
