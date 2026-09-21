# DurableCoordinator constructor option envelope

`DurableCoordinator` treats constructor options as an untrusted runtime boundary. The public `src/durable-coordinator.ts` entry point resolves caller-supplied options before the durable implementation can merge, retain, or act on them.

## Ownership rules

Only declared **own enumerable** option fields participate. This preserves the previous object-spread membership behavior for inherited and non-enumerable declared-name properties without enumerating the caller object. Unknown enumerable properties are ignored and their getters are never executed; resolving declared fields does not invoke `Proxy` `ownKeys`.

Each participating declared field is read exactly once. Validation and the values passed to the durable implementation therefore use the same captured runtime values even when the caller supplied accessors or a Proxy.

## Hostile accessor and Proxy boundary

Top-level record classification is bounded. A revoked options Proxy whose `Array.isArray()` classification throws is rejected through `DurableCoordinator options must be a non-null, non-array object`, rather than leaking a native Proxy exception. Each declared field then has two independently guarded operations: own-property descriptor inspection and the single value read. A throwing descriptor trap fails with `DurableCoordinator option <field> could not be inspected`; a throwing declared getter/value trap fails with `DurableCoordinator option <field> could not be read`.

The caller-provided thrown value is never inspected, stringified, or coerced. In particular, failure handling does not execute hostile `toString()` or `Symbol.toPrimitive` hooks. The guards preserve declared-field order, own/enumerable filtering, no-`ownKeys` behavior, and the one-read contract.

## Validation

The option container, when supplied, must be a non-null, non-array object.

The following duration/runtime controls must be finite, non-negative numbers when supplied:

- `heartbeatIntervalMs`
- `heartbeatTimeoutMs`
- `segmentTimeoutMs`
- `retryDelayMs`
- `leaseTtlMs`
- `checkpointTtlMs`
- `checkpointCleanupIntervalMs`
- `cancelAckDeadlineMs`
- `recoveryOwnershipTtlMs`
- `recoveryOwnershipRenewIntervalMs`
- `recoveryPollIntervalMs`

Timer-backed controls are additionally limited to `2147483647ms` (`MAX_TIMER_DELAY_MS`), the largest delay consistently representable by browser/Node host timers:

- `heartbeatIntervalMs`
- `segmentTimeoutMs`
- `retryDelayMs`
- `checkpointCleanupIntervalMs`
- `recoveryOwnershipRenewIntervalMs`
- `recoveryPollIntervalMs`

Comparison/deadline metadata (`heartbeatTimeoutMs`, `leaseTtlMs`, `checkpointTtlMs`, `cancelAckDeadlineMs`, and `recoveryOwnershipTtlMs`) remains finite/non-negative but is intentionally not capped merely because its numeric value can exceed the host-timer range. These fields are not passed directly to a host timer at this constructor boundary.

`maxCheckpointBytes` must be a non-negative safe integer. This matches the authoritative checkpoint-envelope byte-budget validator, so a fractional or unsafe byte ceiling cannot survive construction and reach a payload-allocation path.

`maxRetries` must also be a non-negative safe integer. Explicit zero remains valid for existing tests/contracts.

`allowFixtureManifest` must be a JavaScript boolean when supplied. Only explicit `true` may relax the production-only model-manifest source gate for tests. Truthy non-boolean values such as the string `"false"` fail before manifest validation and cannot opt into fixture manifests.

## Ordering

Constructor option resolution and validation completes before the core coordinator constructor can initialize repository-backed worker/lease state, timers, recovery state, or apply the fixture-manifest gate. Invalid, inaccessible, or host-timer-overflowing options therefore fail closed without repository/registry side effects.

The direct durable-core checkpoint path also treats its resolved `maxCheckpointBytes` value as untrusted runtime configuration. It rechecks that ceiling as a non-negative safe integer before copying checkpoint payload bytes, so direct-core test/integration callers cannot bypass the allocation-order guarantee by supplying an invalid runtime value.

## Evidence boundary

This hardening is a runtime trust-boundary improvement only. It does not provide new physical WebGPU, real multi-browser relay, real Llama q4 artifact, production deployment, credential, billing, or operator-authorization evidence for #167 or #158.
