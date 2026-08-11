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

function assertDeclaredRequestSize(
  request: Request,
  maximumBytes: number,
  label: string,
): void {
  const rawLength = request.headers.get('Content-Length');
  if (rawLength === null) return;

  const normalized = rawLength.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) return;
  const declaredBytes = Number(normalized);
  if (!Number.isFinite(declaredBytes) || declaredBytes > maximumBytes) {
    throw bodyLimitError(label, maximumBytes);
  }
}

export async function readBoundedJsonRequest(
  request: Request,
  maximumBytes: number,
  label: string,
): Promise<unknown> {
  assertDeclaredRequestSize(request, maximumBytes, label);

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const body = request.body;
  if (body) {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        totalBytes += value.byteLength;
        if (totalBytes > maximumBytes) {
          void reader.cancel(bodyLimitError(label, maximumBytes)).catch(() => {});
          throw bodyLimitError(label, maximumBytes);
        }
        chunks.push(value.slice());
      }
    } finally {
      reader.releaseLock();
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
