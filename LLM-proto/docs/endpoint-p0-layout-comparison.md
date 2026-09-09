# Endpoint P0 4/8 vs 8/8 layout comparison

Status: **diagnostic-only / #223 + #318 pre-decision evidence**.

This comparison does not select an endpoint architecture, change runtime defaults, define a cache/manifest contract, or relax the existing artifact policy. It exists to make one narrow S0/P0 question reproducible before any such decision: what changes arithmetically when the pinned Llama 1B tied endpoint weight moves from **4 physical artifacts / 8 execution tiles** to **8 physical artifacts / 8 execution tiles**?

## Reproducible probe

Run:

```bash
python tools/probe_llama_1b_endpoint_p0_layout_comparison.py /path/to/pinned/model_q4.onnx
```

The helper consumes the existing pinned reports produced by:

- `probe_llama_1b_endpoint_layout_candidates.py`
- `probe_llama_1b_endpoint_dependency_closure.py`

It fail-closes unless both upstream reports keep their expected schema, remain `decisionStatus=diagnostic-only`, and carry the same source graph, external-data identity, and candidate policy. CI runs the comparison against the same immutable 1B graph revision and SHA-256 already used by the other #223 probes.

A successful report has `status=pass` only to mean that this **comparison contract** is internally consistent. It deliberately emits `selectedPhysicalArtifactCount: null`.

## Pinned arithmetic

| metric | 4 physical / 8 tiles | 8 physical / 8 tiles | 8 minus 4 |
|---|---:|---:|---:|
| physical artifact count | 4 | 8 | +4 |
| max physical artifact bytes | 262,668,288 | 131,334,144 | -131,334,144 |
| max execution tile bytes | 131,334,144 | 131,334,144 | 0 |
| max whole-artifact dependency bytes per tile | 262,668,288 | 131,334,144 | -131,334,144 |
| max unused bytes inside required whole artifacts | 131,334,144 | 0 | -131,334,144 |
| physical slices across all 8 execution tiles | 8 | 8 | 0 |
| every execution boundary aligns with a physical boundary | no | yes | — |

Both layouts preserve the same 125.25 MiB (`131,334,144` byte) execution-tile geometry. In the already materialized 4-physical geometry, one execution tile consumes one half of a 250.5 MiB physical artifact, so whole-artifact dependency accounting includes another `131,334,144` bytes that the tile itself does not use. In the 8-physical arithmetic geometry, the physical and execution boundaries are 1:1, so the same conservative accounting has no such unused half-artifact bytes.

That is a useful comparison, but it is not a winner declaration. Increasing physical object count can affect request count, hashing, cache lookup, metadata overhead, eviction behavior, first-useful-work latency, and lifecycle behavior in ways this arithmetic does not measure.

## Single-buffer fit is not working-set evidence

The maximum execution tile remains `131,334,144` bytes, which is why the existing device-budget diagnostic can discuss whether one tile fits a captured WebGPU buffer/storage-binding limit. That statement must not be promoted into a claim that the **total host or GPU working set** fits.

A real ORT Web/WebGPU session may also retain graph state, runtime allocations, uploaded buffers, output buffers, allocator pools, command resources, or previous-session resources. Likewise, a whole physical artifact may be cached or verified without being simultaneously resident as one GPU binding. These are different accounting domains.

The new report therefore carries `remainingEvidence` entries marked `not-measured-by-this-probe` and `requiredBeforeArchitectureSelection=true` for:

- generated 8-physical payload identity,
- pinned ORT Web/WebGPU range supply,
- captured adapter/device limits for both layouts,
- host peak working set,
- GPU peak working set,
- download/cache-read/hash/upload/session/first-useful-work timing,
- session release and cancellation lag,
- pinned-reference numerical equivalence for the 8-physical candidate.

Until those measurements exist, a smaller whole-artifact dependency closure is an arithmetic advantage only.

## Decision boundary

This probe is intentionally safe to run before #223 architecture approval because it does not modify the production/browser runtime contract. If the pinned source graph, row geometry, upstream schemas, or 4/8-vs-8/8 exact values drift, CI fails and requires an explicit diagnostic-contract update rather than silently carrying the old comparison forward.

The next useful step after this contract is not to flip a runtime default. It is to produce comparable browser evidence for the missing 8-physical side using the pinned ORT `1.22.0` range-supply semantics and the same evidence categories already collected for the existing 4-physical path.