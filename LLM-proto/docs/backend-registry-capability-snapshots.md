# BackendRegistry capability snapshots

`WorkerCapability` is a worker-to-Coordinator trust-boundary object. Runtime validation proves that a capability is structurally acceptable at registration time, but TypeScript `readonly` fields do not make the underlying JavaScript object immutable.

The validation boundary now captures the worker-owned capability before structural checks and returns that same owned/frozen state on success. Scalar fields, routing arrays (`inputModalities`, `outputModalities`, `supportedLanguages`, `executionSurfaces`, and `allowedNetworkDestinations`), and optional `health` are therefore not re-read from the worker after acceptance. Accessor- or Proxy-backed values cannot present one routing state to validation and another state to registration.

`BackendRegistry` stores the capability returned by validation directly rather than validating one object and taking a second snapshot afterwards. The stored capability and registry entry are frozen; the executable `InferenceBackend` instance remains unfrozen so its lifecycle methods continue to work normally. `capabilityMatchesRequest()` likewise evaluates capability predicates against the owned state returned by validation instead of re-reading the caller-owned capability after the schema gate.

This prevents a backend, protocol adapter, or caller from changing candidate-selection facts after validation by mutating the original capability object, including drift that occurs during the validation/registration boundary itself. It also prevents callers of `describeAll()` from modifying the registry through references returned for inspection.

A capability change is therefore represented as a new registration/update lifecycle rather than an in-place mutation of already validated routing state. Candidate selection continues to use the same capability schema and predicates; this contract makes the exact state that passed validation stable for the lifetime of the registry entry.
