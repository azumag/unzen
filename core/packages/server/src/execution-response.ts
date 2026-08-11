import {
  createExecutionResponse,
  MAX_EXECUTION_RESPONSE_BYTES,
} from '@unzen/shared';

type ExecutionOutcome =
  | { success: true; result: unknown }
  | { success: false; error: string };

function jsonResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    },
  });
}

function fixedErrorResponse(error: string, status: number): Response {
  return jsonResponse(JSON.stringify(createExecutionResponse({
    success: false,
    error,
  })), status);
}

/** Serialize one fallback response while enforcing the public wire limit. */
export function createExecutionHttpResponse(
  outcome: ExecutionOutcome,
  status = 200,
): Response {
  let body: string;
  try {
    body = JSON.stringify(createExecutionResponse(outcome));
  } catch {
    return fixedErrorResponse('Fallback result is not JSON-serializable', 422);
  }

  if (Buffer.byteLength(body, 'utf8') > MAX_EXECUTION_RESPONSE_BYTES) {
    if (!outcome.success) {
      return fixedErrorResponse('Server execution failed', status);
    }
    return fixedErrorResponse(
      `Fallback response exceeds ${MAX_EXECUTION_RESPONSE_BYTES} bytes`,
      422,
    );
  }

  return jsonResponse(body, status);
}
