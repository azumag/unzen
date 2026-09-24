# WebGPU diagnostic server port runtime boundary

The local WebGPU diagnostic harnesses share `resolveWebgpuDiagnosticPort()` before creating or listening on an HTTP server.

`PORT` is runtime input even when it normally comes from `process.env`. The resolver therefore accepts only JavaScript `string` and `number` values before numeric conversion. This preserves the existing environment-variable and explicit numeric-port behavior (including numeric strings with surrounding whitespace), while rejecting booleans, arrays, bigint values, objects, functions, and other coercible values without invoking caller-owned `valueOf()` / `toString()` hooks.

After the primitive type boundary, the resolved value must be an integer in the TCP port range `1..65535`. Invalid explicit values and invalid custom defaults fail before server construction/listen side effects in callers that perform port preflight.

This is local diagnostic configuration hardening only. It does not change the browser artifact policy, model execution contract, Coordinator relay protocol, production deployment configuration, or any readiness/evidence status.
