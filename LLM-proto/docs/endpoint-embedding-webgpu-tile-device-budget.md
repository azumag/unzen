# Endpoint embedding WebGPU tile device-budget verification

Status: **diagnostic-only / #223 S0 support**. This check does not select the 4-way physical / 8-way execution candidate and does not change production manifest, cache, loader, runtime, residency, dispatcher, or artifact-policy behavior.

## Purpose

The pinned complete embedding experiment keeps four browser-cache payloads of `262,668,288` bytes each, but executes each payload as two vocabulary-row tiles of `131,334,144` bytes (`125.25 MiB`) each. Those are different resource boundaries: the physical payload is the host/download/cache unit used by this diagnostic, while the tile byte length is the pinned external initializer range used by one ORT session.

`tools/verify_endpoint_embedding_webgpu_tile_device_budget.mjs` makes that distinction explicit for persisted `captured-browser-runtime` evidence. It first runs the existing primary captured-evidence validator, so source identity, Chrome/CDP identity, adapter context, all four payload identities, all eight tile routes, graph digests, numerical equality, timestamps, and release evidence must already pass. It then derives the largest execution tile and largest physical payload from the pinned contract rather than trusting numbers supplied by the evidence file.

The focused device-budget gate requires the captured adapter's:

- `maxBufferSize >= maximumExecutionTileBytes`
- `maxStorageBufferBindingSize >= maximumExecutionTileBytes`

For the current pinned geometry, `maximumExecutionTileBytes` is `131,334,144`. A `128 MiB` (`134,217,728` byte) storage-binding limit therefore leaves only `2,883,584` bytes of numerical headroom over the tile initializer. The check deliberately reports the `262,668,288`-byte maximum physical artifact separately and does **not** require that host/cache unit to fit one GPU storage binding.

## Run

After obtaining a captured endpoint embedding report:

```bash
cd LLM-proto
node tools/verify_endpoint_embedding_webgpu_tile_device_budget.mjs \
  /tmp/endpoint-embedding-webgpu-runtime.json
```

A passing report records the pinned physical-artifact/tile counts, maximum physical-artifact bytes, maximum execution-tile bytes, captured adapter identity/limits, and per-limit available/required/headroom bytes. If either relevant adapter limit is below the largest tile, verification fails closed.

## Interpretation boundary

This is a necessary capability/accounting check, not proof of GPU memory safety. `adapterLimits` describe the WebGPU adapter observed by the harness. The report does not prove the exact limits requested or granted to ONNX Runtime Web's internal `GPUDevice`, does not prove that every model node executed on WebGPU, and does not measure allocator overhead, upload staging, scratch buffers, peak host/GPU memory, or post-`release()` reclamation. A positive `2,883,584`-byte storage-binding margin is therefore not treated as a memory-performance margin.

Likewise, the check does not reinterpret the four `250.5 MiB` physical payloads as GPU buffers. The existing harness supplies verified payload bytes to ORT's external-data override while the pinned graph selects one `125.25 MiB` initializer range per tile. Whether a future production loader should keep four physical artifacts, use eight smaller physical artifacts, or adopt another B1 layout remains a maintainer decision under #223/#167.

A pass only strengthens S0 evidence interpretation: the captured adapter advertises limits large enough for the pinned execution-tile geometry, while `decisionStatus` remains `diagnostic-only`.
