# Coordinator prototype failure-reporting boundary

`runCoordinatorPrototype()` treats the dispatcher failure path as a runtime trust boundary. The dispatcher normally throws ordinary `Error` instances, but JavaScript callers and tests can cross the TypeScript boundary with arbitrary thrown values, revoked proxies, or objects whose coercion hooks and property accessors throw.

The prototype therefore captures `manifest.requestId` once before dispatch and reuses that owned primitive for the dispatcher call, synthesized fallback report, and final `CoordinatorPrototypeReport`. A caller-owned accessor cannot return one request ID for dispatch and a different request ID while the fallback report is being built.

Dispatcher failures are formatted without coercing object or function values. Primitive thrown values keep their safe string representation, and a normal `Error` keeps its string `message` when that property can be read safely. Revoked proxies, values that fail `instanceof`, non-`Error` objects/functions, throwing `message` accessors, and non-string `message` values map to the stable fallback `Unknown error`. Values thrown while probing the failure are not stringified or otherwise coerced.

This boundary only changes failure reporting. Assignment policy, worker eligibility, retry/resume interpretation, checkpoint relay accounting, and transport allowlisting remain unchanged. The resulting report still returns `status: 'fail'` with deterministic empty dispatcher assignments when dispatch itself fails.

Focused regression coverage lives in `tests/coordinator-prototype-failure-boundary.test.ts` and covers request-ID single-read behavior, revoked proxies, hostile coercion hooks, hostile `Error.message` access, ordinary errors, and primitive failures.

This is prototype/runtime reliability hardening only. It is not new evidence of real `Llama-3.2-1B-Instruct` q4 execution, physical WebGPU, distinct-browser Coordinator relay/latency, worker-loss/resume, or artifact residency for #167.
