# AdaptiveChunkDispatcher segment runtime envelope

`AdaptiveChunkDispatcher` accepts segment configuration through a TypeScript interface, but callers may still supply asserted, deserialized, accessor-backed, proxied, or otherwise runtime-originated values. The constructor therefore treats both the top-level options value and `segments` as an untrusted runtime boundary.

## Contract

The dispatcher binds construction to one caller-observed segment container and one detached top-level membership snapshot before it reads any segment fields or allows `ArtifactResidencyLedger.assertCompatibleSegments()` to inspect the resulting configuration.

- top-level options must be a non-null, non-array object; revoked proxies fail in this existing validation bucket
- `options.segments` is captured exactly once through a bounded property read; a throwing getter/trap becomes a dispatcher-owned diagnostic and the thrown value is never inspected or coerced
- the captured `segments` value must be an array and must remain non-empty; revoked array proxies fail closed as invalid segment containers
- array `length` is captured once through a bounded read and must be a valid JavaScript array length (`0..2^32-1`); this is the platform array invariant, not a new dispatcher policy cap
- every top-level segment reference is captured once by fixed numeric position before any segment field is read; throwing numeric-index traps become dispatcher-owned diagnostics
- caller-overridden iteration is not used to capture segment membership
- every captured segment must be a non-null, non-array object; revoked proxies fail through the same record-validation bucket
- each captured segment field (`index`, `layerStart`, `layerEnd`, `modelWeightHash`, `estimatedVramMB`) is read exactly once through a bounded accessor into a local primitive before validation
- if a segment field accessor throws, the dispatcher reports the unreadable field without stringifying, coercing, or otherwise inspecting the thrown value
- `index` must be a non-negative safe integer and equal its array position
- `layerStart` must be a non-negative safe integer
- `layerEnd` must be a safe integer greater than or equal to `layerStart`
- adjacent segment layer ranges must be contiguous
- `modelWeightHash` must be a non-empty string
- `estimatedVramMB` must be a positive finite number

After membership capture, validation proceeds in array order. The same captured primitive values drive validation, error reporting, and construction of the frozen plain-object segment snapshots. A getter on an earlier segment therefore cannot replace a later caller-owned array slot, and a valid-first / altered-second getter on an individual field cannot make the accepted value differ from the value retained by the dispatcher. Later caller mutation likewise cannot change routing geometry, cache-hit range validation, or manifest-backed compatibility decisions.

The proxy/accessor operations used to classify and capture the segment envelope above are bounded locally. The dispatcher does not stringify or classify values thrown by those traps, so hostile `Symbol.toPrimitive`, `valueOf`, or `toString` hooks cannot replace the intended validation failure with a caller-controlled exception. Other constructor option fields retain their existing validation contracts and are outside this segment-envelope hardening change.

## Compatibility

The runtime boundary deliberately does not narrow `modelWeightHash` to a canonical digest syntax. Existing prototype values such as `sha256:seg-0` remain valid. Per-segment validation order, contiguous-range checks, load/VRAM/checkpoint option semantics, adaptive scoring/routing policy, and ledger compatibility checks are unchanged. No arbitrary maximum segment count is introduced by this hardening; only the JavaScript array-length domain is enforced before allocation/capture.

This contract is a coordinator/runtime hardening measure. It is not evidence of real-device WebGPU execution, physical GPU memory use, multi-browser relay latency, or worker-loss resume behavior.
