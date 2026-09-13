# Validated model manifest ownership

`validateModelManifestShape()` is both a structural validation boundary and an ownership boundary. A successful result now contains an owned runtime snapshot rather than the caller-owned manifest object.

The snapshot freezes the root manifest, `segments`, every segment object, each segment's `compatibleRuntimes`, optional component arrays and component objects, `runtimeRequirements`, and `supportedQuantization`. This prevents a caller that still holds the parsed JSON object from changing model revision, geometry, artifact identity, runtime compatibility, or quantization policy after validation.

`validateModelManifest()` performs component-bundle verification, manifest digest verification, and optional signature verification against the same stable snapshot. Mutating the original input after asynchronous verification begins therefore cannot race the digest/signature checks.

This is runtime ownership and integrity hardening only. It is not new evidence for real Llama-3.2-1B q4 materialization, physical WebGPU working-set size, real multi-browser relay/latency, or worker-loss behavior tracked by #167.
