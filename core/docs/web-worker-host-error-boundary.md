# WebWorkerSandboxExecutor host/runtime error boundary

`WebWorkerSandboxExecutor` accepts caller-owned execution inputs and an optional injectable Worker factory. Those values can cross catch paths before the QuickJS worker protocol has a chance to classify failures, so host/runtime failures must be normalized without invoking caller-controlled coercion.

The executor keeps the existing public taxonomy:

- invalid QuickJS options, arguments, and structural `AbortSignal` operations settle as `UnzenFunctionError`;
- Worker creation, configuration, initialization, and `postMessage()` failures settle as `UnzenRuntimeError`;
- caller cancellation keeps `UnzenCancelledError` precedence;
- hard execution deadlines keep `UnzenDeadlineExceededError` semantics.

## Custom Worker lifecycle ownership

A caller-provided `createWorker` factory is wrapped at the shared worker-executor boundary. The wrapper snapshots the minimal `postMessage` / `terminate` method surface once, forwards `onmessage` / `onerror` assignment to the underlying Worker, and bounds failures from factory invocation, handler configuration, `postMessage`, and termination.

Ordinary `Error` instances with a safely readable string `message` contribute that message to a new executor-owned `Error`; the caller-owned error object itself is never propagated across the boundary. Primitive thrown values retain their useful textual diagnostic. Other object/function values, revoked Proxies, throwing prototype checks, and throwing/non-string `message` accessors collapse to an owned `Error('Unknown error')`. Diagnostic normalization never calls caller-owned `Symbol.toPrimitive`, `valueOf`, or `toString`.

The default browser `new Worker(...)` factory is not wrapped; browser-native failures already enter the executor as ordinary platform exceptions. The bounded facade is specifically for the injectable caller-owned Worker boundary.

## Ordering and side effects

The hardening does not change single-flight queue ownership, generation IDs, timeout start points, restart accounting, worker protocol schema, or cancellation races. Invalid option/call snapshots and malformed structural signals still fail before Worker creation. A failed custom Worker lifecycle operation settles through the same existing catch site, so queue draining and teardown remain owned by `WebWorkerSandboxExecutor`.

Constructor option classification also treats revoked option-container Proxies as a stable invalid options bag rather than leaking `Array.isArray()`'s native exception.

This is a runtime reliability/trust-boundary contract. It is not real-model, physical WebGPU, relay-latency, worker-loss/resume, or residency evidence for issue #167.
