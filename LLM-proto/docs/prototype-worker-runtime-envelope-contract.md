# Simulated prototype worker runtime envelope

`SimulatedPrototypeWorker` is a contract-tested worker used by the two-worker relay/resume harness. Its constructor may receive asserted or deserialized values despite the TypeScript `PrototypeWorkerOptions` surface, so worker identity and report metadata are validated before any worker state is created.

## Constructor contract

The top-level options value must be a non-null, non-array object. Field validation then applies in this order:

- `id` uses the shared `workerId()` authority.
- `segmentIndex` must be exactly `0` or `1`.
- `webgpuAdapter` must be a non-empty runtime string.
- `vramMB` must be a positive finite runtime number.
- `failFirstRun`, when supplied, must be boolean. `undefined` preserves the existing default of `false`.

Rejected input fails before `cachedSegments`, retry behavior, CDN locator selection, or report metadata can depend on malformed values.

## Preserved behavior

Valid workers keep the existing fixed `WorkerTier.TIER_2` metadata, segment-specific execution behavior, cache-hit accounting, and one-shot `failFirstRun` retry simulation. No routing, transport allowlist, or model segmentation policy changes are introduced.

## Evidence boundary

This validation protects the integrity of the contract-tested relay/resume harness and the metadata it reports. It is prototype runtime-boundary hardening only; it does not count as real prepared 1B, physical WebGPU, multi-browser relay, latency, or worker-loss evidence for #167.
