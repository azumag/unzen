# BackendRegistry capability snapshots

`WorkerCapability` is a worker-to-Coordinator trust-boundary object. Runtime validation proves that a capability is structurally acceptable at registration time, but TypeScript `readonly` fields do not make the underlying JavaScript object immutable.

`BackendRegistry` therefore stores capabilities by value rather than retaining worker-owned references:

- validate the complete capability before it enters the routing table;
- copy and freeze the top-level capability object;
- copy and freeze every routing-relevant array (`inputModalities`, `outputModalities`, `supportedLanguages`, `executionSurfaces`, and `allowedNetworkDestinations`);
- copy and freeze the optional `health` object;
- freeze the registry entry itself;
- keep the executable `InferenceBackend` instance unfrozen so its lifecycle methods continue to work normally.

This prevents a backend, protocol adapter, or caller from changing candidate-selection facts after validation by mutating the original capability object. It also prevents callers of `describeAll()` from modifying the registry through references returned for inspection.

A capability change is therefore represented as a new registration/update lifecycle rather than an in-place mutation of already validated routing state. Candidate selection continues to use the same capability schema and predicates; this contract only makes the validated snapshot stable for the lifetime of the registry entry.
