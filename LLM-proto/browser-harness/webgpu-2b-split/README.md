# WebGPU two-browser split harness

The browser worker registration contract is defined in `runtime-validation.js`.

- `DEFAULT_BROWSER_WORKER_ROLE` is the single browser-side default used when the `role` query parameter is omitted.
- The default is `segment0`.
- Explicit browser roles remain limited to `segment0`, `segment1`, and `standby` by `validateBrowserWorkerRegistrationConfig()`.
- `runner-bootstrap.js` and `runner-v3.js` must both resolve an omitted `role` through `DEFAULT_BROWSER_WORKER_ROLE` so preflight validation and execution cannot drift.
- Explicit worker IDs continue to use the same Coordinator-compatible syntax; when `worker` is omitted, `runner-v3.js` generates an ID prefixed with the resolved role.

Keep this browser-side default separate from Coordinator trust checks: the Coordinator still validates the role and worker identity on registration.
