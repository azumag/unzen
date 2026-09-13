# Two-worker prototype run runtime envelope

`TwoWorkerPrototypeRunner.run()` is a public contract-harness boundary. Although its TypeScript surface accepts `TwoWorkerPrototypeOptions`, callers can still provide asserted or deserialized runtime values. Run inputs are therefore preflighted before a request ID is allocated or worker/transport state can change.

## Preflight contract

- The top-level options value must be a non-null, non-array object.
- `prompt` must be an actual runtime string. Existing prompt-content semantics are preserved, including empty and whitespace-only strings.
- `coordinatorUrl` and `cdnUrl` retain their existing defaults when omitted (`undefined`).
- When supplied, each URL must be a non-empty string, parse as an absolute URL, and have a network origin.

Only after all fields pass preflight does the runner capture the transport history cursor, increment its request counter, or execute segment 0.

## Failure isolation

A malformed run envelope must not consume a request ID, append transport history, or warm a simulated worker's segment cache. This ensures a later valid run starts from the same observable harness state it would have had if the malformed call had never occurred.

Allowlist authorization remains a separate transport responsibility: a syntactically valid network URL outside the configured `AllowlistedPrototypeTransport` allowlist still fails closed at `connect()` under the existing policy.

## Evidence boundary

This change makes the contract-tested two-worker report and retry/resume harness deterministic in the presence of malformed runtime input. It does not add real prepared-model, physical WebGPU, multi-browser relay, latency, or worker-loss evidence for #167.
